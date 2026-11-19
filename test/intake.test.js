import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('portal intake, concurrent retries, routing and transfers against D1', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "crm-test",
    modules: true,
    scriptPath: 'src/index.js',
    compatibilityDate: '2026-09-01',
    d1Databases: ['DB'],
    bindings: { ADMIN_TOKEN: 'test-admin', INTAKE_TOKEN_99ACRES: 'test-acres', INTAKE_TOKEN_MAGICBRICKS: 'test-magic', INTAKE_TOKEN_METAADS: 'test-meta', PROPERTY_CODE_MAP: { 'OFFICE-TEST': 'Office' } },
  }));
  try {
    const db = await mf.getD1Database('DB');
    const schema = await readFile('schema.sql', 'utf8');
    // Run complete statements; trigger BEGIN/END is a single statement.
    const [tables, trigger] = schema.split('CREATE TRIGGER');
    for (const part of tables.replace(/--[^\n]*/g, '').split(';').map(s=>s.trim()).filter(Boolean)) await db.prepare(part).run();
    await db.prepare('CREATE TRIGGER'+trigger).run();
    for (const part of (await readFile('seed.sql','utf8')).replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean)) await db.prepare(part).run();
    async function call(path, options = {}) {
      const res = await mf.dispatchFetch('http://crm.test'+path, options);
      return { status: res.status, body: await res.json() };
    }
    const admin = { authorization: 'Bearer test-admin', 'content-type': 'application/json' };
    const customTeam = await call('/api/teams', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'North Mumbai Team' }) });
    assert.equal(customTeam.status, 201, JSON.stringify(customTeam.body));
    assert.equal(customTeam.body.team.name, 'North Mumbai Team');
    const sameCustomTeam = await call('/api/teams', { method: 'POST', headers: admin, body: JSON.stringify({ name: ' north mumbai team ' }) });
    assert.equal(sameCustomTeam.status, 200, JSON.stringify(sameCustomTeam.body));
    assert.equal(sameCustomTeam.body.created, false);
    assert.equal(sameCustomTeam.body.team.id, customTeam.body.team.id);
    async function post(payload, source='99acres') {
      return call('/api/intake/'+source+'?token='+(source==='99acres'?'test-acres':'test-magic'), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    }
    assert.equal((await call('/api/leads')).status, 401);
    assert.equal((await call('/api/intake/99acres?Mobile=9999999999')).status, 401);
    assert.equal((await post({First_Name:'No contact'})).status, 422);
    assert.equal((await post({Mobile:{bad:'object'}})).status, 422);
    assert.equal((await post({Mobile:'9999999999', junk:'x'.repeat(66000)})).status,400);
    const payload = {First_Name:'Test customer', Mobile:'9999999999', Project_Name:'Test Project', Price:'65-85 Lakh', token:'must-not-store'};
    const retries = await Promise.all(Array.from({length:6},()=>post(payload)));
    for (const result of retries) assert.equal(result.status,200, JSON.stringify(result.body));
    assert.equal(retries.filter(r=>r.body.duplicate).length,5);
    assert.equal(await db.prepare('SELECT COUNT(*) n FROM leads').first('n'),1);
    const id=retries.find(r=>!r.body.duplicate).body.lead_id;
    let detail=(await call('/api/leads/'+id,{headers:admin})).body;
    assert.equal(detail.lead.customer_name,'Test customer');
    assert.equal(detail.lead.budget_min,6500000);
    assert.equal(detail.lead.budget_max,8500000);
    assert.equal(JSON.parse(detail.lead.raw_payload).token,undefined);
    assert.equal(detail.history.length,1);
    const enquiries = await Promise.all(Array.from({length:6},(_,i)=>post({...payload, Project_Name:'Separate project '+i})));
    assert.equal(enquiries.every(result=>result.body.assigned_user_id===null),true);
    const queued = (await call('/api/assignment-approvals',{headers:admin})).body.approvals;
    const queuedEnquiries = queued.filter(approval=>enquiries.some(result=>result.body.lead_id===approval.lead_id));
    const recommendedUsers=queuedEnquiries.map(approval=>approval.recommended_user_id);
    assert.equal(recommendedUsers.filter(id=>id==='u_priya').length,3);
    assert.equal(recommendedUsers.filter(id=>id==='u_arjun').length,3);
    const office=await post({Email:'office@example.invalid',Property_Code:'OFFICE-TEST'});
    assert.equal(office.body.team_id,'team_commercial');
    const magic=await call('/api/intake/magicbricks?token=test-magic&senderName=Magic&senderPhone=8888888888');
    assert.equal(magic.status,200);
    const form=await call('/api/intake/99acres?token=test-acres',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'Mobile=7777777777&First_Name=Form'});
    assert.equal(form.status,200);
    await post({lead_id:'fixed-id',Email:'a@example.invalid'});
    assert.equal((await post({lead_id:'fixed-id',Email:'changed@example.invalid'})).body.duplicate,true);
    assert.equal((await call('/api/leads/'+id+'/assign',{method:'POST',headers:admin,body:JSON.stringify({to_user_id:'u_rakesh',to_team_id:'team_sales'})})).status,422);
    const transfer=await call('/api/leads/'+id+'/assign',{method:'POST',headers:admin,body:JSON.stringify({to_user_id:'u_rakesh',note:'test transfer',actor_user_id:'spoof'})});
    assert.equal(transfer.status,200,JSON.stringify(transfer.body));
    assert.equal(transfer.body.lead.team_id,'team_commercial');
    assert.equal(transfer.body.history.length,2);
    assert.equal(transfer.body.history[1].actor_user_id,'super-admin');
    assert.equal(transfer.body.history[1].from_user_id,detail.lead.assigned_user_id);
    assert.equal((await call('/api/leads?limit=-1&offset=-3',{headers:admin})).body.limit,1);

    // End-to-end employee workflow: auto-routing balances recommendations, a
    // manager approves or changes them, then an agent progresses a lead, asks
    // for a transfer, and the recipient accepts it.
    await db.prepare("INSERT INTO teams (id,name) VALUES ('team_e2e','E2E Team')").run();
    await db.prepare("INSERT INTO routing_rules (name,priority,match_property_type,team_id,strategy) VALUES ('E2E Villa',1,'Villa','team_e2e','least_loaded')").run();
    const createEmployee = async (name, email) => call('/api/users', {method:'POST',headers:admin,body:JSON.stringify({name,email,role:'agent',team_id:'team_e2e'})});
    const alice = await createEmployee('Alice Agent','alice@example.invalid');
    const ben = await createEmployee('Ben Agent','ben@example.invalid');
    const manager = await call('/api/users', {method:'POST',headers:admin,body:JSON.stringify({name:'E2E Manager',email:'manager@example.invalid',role:'manager',team_id:'team_e2e'})});
    assert.equal(alice.status,201); assert.equal(ben.status,201); assert.equal(manager.status,201);
    const aliceAuth={authorization:'Bearer '+alice.body.access_token,'content-type':'application/json'};
    const benAuth={authorization:'Bearer '+ben.body.access_token,'content-type':'application/json'};
    const managerAuth={authorization:'Bearer '+manager.body.access_token,'content-type':'application/json'};
    assert.equal((await call('/api/me',{headers:aliceAuth})).body.user.role,'agent');
    assert.equal((await call('/api/users',{headers:aliceAuth})).body.users.every(u=>u.team_id==='team_e2e'),true);
    const routed=[];
    for (let i=0;i<4;i++) routed.push(await post({lead_id:'villa-'+i,Mobile:'700000000'+i,Property_Type:'Villa'}));
    assert.equal(routed.every(result=>result.body.assigned_user_id===null),true);
    assert.equal((await call('/api/assignment-approvals',{headers:aliceAuth})).status,403);
    const pendingApprovals = (await call('/api/assignment-approvals',{headers:managerAuth})).body.approvals
      .filter(approval=>routed.some(result=>result.body.lead_id===approval.lead_id));
    assert.equal(pendingApprovals.length,4);
    assert.deepEqual(pendingApprovals.map(approval=>approval.recommended_user_id).sort(), [alice.body.user_id,alice.body.user_id,ben.body.user_id,ben.body.user_id].sort());
    const expectedOwners = new Map();
    for (const [i, approval] of pendingApprovals.entries()) {
      const target = i === 1
        ? (approval.recommended_user_id===alice.body.user_id ? ben.body.user_id : alice.body.user_id)
        : approval.recommended_user_id;
      const decision = await call('/api/assignment-approvals/'+approval.id+'/decide',{method:'POST',headers:managerAuth,body:JSON.stringify({to_user_id:target})});
      assert.equal(decision.status,200,JSON.stringify(decision.body));
      assert.equal(decision.body.assignment_approval.status, i===1 ? 'changed' : 'approved');
      assert.equal(decision.body.lead.assigned_user_id,target);
      expectedOwners.set(approval.lead_id,target);
    }
    assert.equal((await call('/api/assignment-approvals',{headers:managerAuth})).body.approvals.some(approval=>expectedOwners.has(approval.lead_id)),false);
    const allocated = await Promise.all(routed.map(result=>call('/api/leads/'+result.body.lead_id,{headers:admin})));
    assert.deepEqual(allocated.map(result=>result.body.lead.assigned_user_id).sort(), [...expectedOwners.values()].sort());
    const aliceLead=allocated.find(result=>result.body.lead.assigned_user_id===alice.body.user_id).body.lead.id;
    assert.equal((await call('/api/leads/'+aliceLead+'/assign',{method:'POST',headers:aliceAuth,body:JSON.stringify({to_user_id:ben.body.user_id})})).status,403);
    const progressed=await call('/api/leads/'+aliceLead,{method:'PATCH',headers:aliceAuth,body:JSON.stringify({stage:'qualified',priority:'high',next_follow_up_at:'2026-12-01T09:00:00'})});
    assert.equal(progressed.status,200); assert.equal(progressed.body.lead.stage,'qualified'); assert.equal(progressed.body.lead.status,'in_process');
    assert.equal((await call('/api/leads/'+aliceLead+'/activities',{method:'POST',headers:aliceAuth,body:JSON.stringify({type:'call',subject:'Qualification call'})})).status,201);
    const request=await call('/api/leads/'+aliceLead+'/transfer-requests',{method:'POST',headers:aliceAuth,body:JSON.stringify({to_user_id:ben.body.user_id,note:'Client prefers evening calls'})});
    assert.equal(request.status,201);
    const requestId=(await call('/api/leads/'+aliceLead,{headers:admin})).body.transfers[0].id;
    assert.equal((await call('/api/transfers/'+requestId+'/respond',{method:'POST',headers:aliceAuth,body:JSON.stringify({decision:'accepted'})})).status,403);
    assert.equal((await call('/api/transfers/'+requestId+'/respond',{method:'POST',headers:benAuth,body:JSON.stringify({decision:'accepted'})})).status,200);
    const finalLead=(await call('/api/leads/'+aliceLead,{headers:admin})).body;
    assert.equal(finalLead.lead.assigned_user_id,ben.body.user_id);
    assert.equal(finalLead.transfers[0].status,'accepted');
    assert.equal(finalLead.activities[0].subject,'Qualification call');
    assert.equal(finalLead.stage_history[0].to_stage,'qualified');
    assert.equal(finalLead.history.at(-1).reason,'transfer:accepted');
    assert.equal((await call('/api/users/'+ben.body.user_id,{method:'PATCH',headers:aliceAuth,body:JSON.stringify({is_active:false})})).status,403);
    assert.equal((await call('/api/users/'+ben.body.user_id,{method:'PATCH',headers:admin,body:JSON.stringify({availability:'away'})})).status,200);
    assert.equal((await call('/api/users',{headers:admin})).body.users.find(u=>u.id===ben.body.user_id).accepts_leads,0);
    const employeeLead = await call('/api/leads',{method:'POST',headers:aliceAuth,body:JSON.stringify({customer_name:'Employee walk-in',phone:'7666666666'})});
    assert.equal(employeeLead.status,200,JSON.stringify(employeeLead.body));
    assert.equal(employeeLead.body.lead.customer_name,'Employee walk-in');
    assert.equal(employeeLead.body.lead.assigned_user_id,alice.body.user_id);
    const manual = await call('/api/leads',{method:'POST',headers:admin,body:JSON.stringify({customer_name:'Walk-in buyer',phone:'7555555555',project_name:'Model home',property_type:'Villa',location:'Pune',budget_min:'80 L',budget_max:'1 Cr',priority:'high'})});
    assert.equal(manual.status,200);
    assert.equal(manual.body.lead.source,'manual');
    assert.equal(manual.body.lead.customer_name,'Walk-in buyer');
    assert.equal(manual.body.lead.budget_min,8000000);
    assert.equal(manual.body.lead.budget_max,10000000);
    assert.equal(manual.body.lead.assigned_user_id,null);
    assert.equal(manual.body.assignment_approval.status,'pending');
    const approvedManual = await call('/api/assignment-approvals/'+manual.body.assignment_approval.id+'/decide',{method:'POST',headers:managerAuth,body:JSON.stringify({to_user_id:alice.body.user_id})});
    assert.equal(approvedManual.status,200,JSON.stringify(approvedManual.body));
    assert.equal(approvedManual.body.lead.assigned_user_id,alice.body.user_id);
    const chosenDetails = await call('/api/leads', {method:'POST',headers:admin,body:JSON.stringify({
      customer_name:'Referred buyer', phone:'7444444444', source:'referral', status:'in_process',
      client_status:'nearing_possession', assigned_user_id:ben.body.user_id,
    })});
    assert.equal(chosenDetails.status,200,JSON.stringify(chosenDetails.body));
    assert.equal(chosenDetails.body.lead.source,'referral');
    assert.equal(chosenDetails.body.lead.status,'in_process');
    assert.equal(chosenDetails.body.lead.client_status,'nearing_possession');
    assert.equal(chosenDetails.body.lead.assigned_user_id,ben.body.user_id);
    assert.equal(chosenDetails.body.history.length,1);
    assert.equal(chosenDetails.body.history[0].reason,'manual');
    const employeeProperty = await call('/api/properties',{method:'POST',headers:aliceAuth,body:JSON.stringify({name:'Employee property'})});
    assert.equal(employeeProperty.status,201,JSON.stringify(employeeProperty.body));
    assert.equal(await db.prepare('SELECT created_by_user_id FROM properties WHERE id=?1').bind(employeeProperty.body.property_id).first('created_by_user_id'),alice.body.user_id);
    const builderBrochureUrl = 'https://builder.example.invalid/brochures/lakeview-villas.pdf';
    assert.equal((await call('/api/properties',{method:'POST',headers:admin,body:JSON.stringify({name:'Lakeview Villas',developer:'Test Developer',property_type:'Villa',location:'Pune',locality:'Kharadi',society_name:'Lakeview Residency',tower_count:4,budget_min:'75 Lakh',budget_max:'1.2 Cr',bedrooms:'3 BHK',builder_brochure_url:builderBrochureUrl})})).status,201);
    const matches = await call('/api/properties?property_type=Villa&location=Pune&budget_min=8000000&budget_max=10000000',{headers:admin});
    assert.equal(matches.status,200);
    assert.equal(matches.body.properties.length,1);
    assert.equal(matches.body.properties[0].name,'Lakeview Villas');
    assert.equal(matches.body.properties[0].builder_brochure_url,builderBrochureUrl);
    assert.equal(matches.body.properties[0].tower_count,4);
    assert.equal(matches.body.properties[0].availability,'yes');
    const unavailableProperty = await call('/api/properties',{method:'POST',headers:admin,body:JSON.stringify({name:'Unavailable test property',availability:'no'})});
    assert.equal(unavailableProperty.status,201);
    assert.equal(await db.prepare('SELECT availability FROM properties WHERE id=?1').bind(unavailableProperty.body.property_id).first('availability'),'no');
    assert.equal((await call('/api/properties',{method:'POST',headers:admin,body:JSON.stringify({name:'Invalid tower count',tower_count:0})})).status,422);
    assert.equal((await call('/api/properties',{method:'POST',headers:admin,body:JSON.stringify({name:'Unsafe brochure link',builder_brochure_url:'javascript:alert(1)'})})).status,422);
    assert.equal((await call('/api/settings',{method:'PATCH',headers:aliceAuth,body:JSON.stringify({business_name:'Blocked'})})).status,403);
    const settings = await call('/api/settings',{method:'PATCH',headers:admin,body:JSON.stringify({business_name:'Northstar Realty',workspace_name:'Simple Leads',welcome_text:'A clear place for every buyer.'})});
    assert.equal(settings.status,200);
    assert.equal(settings.body.settings.business_name,'Northstar Realty');
    assert.equal((await call('/api/settings',{headers:admin})).body.settings.workspace_name,'Simple Leads');
    await call('/api/properties',{method:'POST',headers:admin,body:JSON.stringify({name:'Pune Hinjewadi Apartments',property_type:'Apartments',location:'Pune',budget_min:'70 Lakh',budget_max:'80 Lakh'})});
    const smartMatches = await call('/api/properties?property_type=Apartment&location=Pune&budget_min=7000000&budget_max=8000000',{headers:admin});
    const apartment = smartMatches.body.properties.find(p=>p.name==='Pune Hinjewadi Apartments');
    assert.ok(apartment, 'singular Apartment should match catalogue value Apartments');
    assert.deepEqual(apartment.match_reasons.sort(), ['budget','location','property type']);
    const publicLead = await call('/api/public/enquiries',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Meta website visitor',phone:'7333333333',email:'meta@example.invalid',project_name:'Landing page property',property_type:'Apartment',location:'Pune',budget_min:'70 Lakh',budget_max:'80 Lakh',website:''})});
    assert.equal(publicLead.status,200);
    const publicDetail = await call('/api/leads/'+publicLead.body.lead_id,{headers:admin});
    assert.equal(publicDetail.body.lead.source,'meta_ads');
    assert.equal(publicDetail.body.lead.customer_name,'Meta website visitor');
    assert.equal((await call('/api/public/enquiries',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Bot',phone:'7222222222',website:'spam'})})).body.lead_id,undefined);
  } finally { await mf.dispose(); }
});
