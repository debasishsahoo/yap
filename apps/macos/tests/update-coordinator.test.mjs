import assert from "node:assert/strict";
import { test } from "node:test";
import { checkServiceHost } from "./fixtures/swift-service-host.mjs";
const peer = `
import {createInterface} from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message)+'\\n');
send({event:'started',pid:process.pid,socketPath:'/scratch/service.sock'});
let permit;
createInterface({input:process.stdin}).on('line', line => {
 const {request} = JSON.parse(line);
 if (request.operation === 'update.prepare') permit = 'permit';
 if (request.operation === 'update.release') permit = undefined;
 if (request.operation === 'service.health' && permit) {
  send({event:'result',response:{id:request.id,ok:false,error:{code:'UPDATING',message:'permit still held'}}}); return;
 }
 const data = request.operation === 'update.prepare' ? {kind:'prepared',permitId:'permit'} : {released:true};
 send({event:'result',response:{id:request.id,ok:true,data}});
}).on('close',()=>process.exit(0));
`;
function run(t, body, child = peer) {
  const result = checkServiceHost(
    t,
    child,
    `
 var blockers = ["native.countdown"]; var fenced = false; var trace: [String] = []
 let owner = UpdateCoordinator(blockers: { blockers }, fence: { fenced = $0 }, changed: {})
 owner.attach(to: host); owner.setAvailability(true, enabled: true); owner.candidate(version: "2")
 ${body}
 `,
    ["UpdateCoordinator"],
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim().split("\n");
}
test("a one-shot check with automatic updates off waits for idle and authorizes only after clean exit", (t) => {
  assert.deepEqual(
    run(
      t,
      `
 owner.setEnabled(false)
 try! owner.beginManualCheck()
 owner.candidate(version: "2")
 owner.ready(install: { trace.append("install"); owner.installing { trace.append("authorize") } },
             cancel: { trace.append("cancel") })
 try? await Task.sleep(for: .milliseconds(30))
 guard !owner.enabled, trace.isEmpty, !fenced, owner.status.state == "waiting" else { exit(1) }
 _ = try! await host.call("service.health")
 blockers = []; owner.progress()
 for _ in 0..<200 { if owner.mayTerminateForUpdate { break }; try? await Task.sleep(for: .milliseconds(10)) }
 guard !owner.enabled, owner.cleanServiceExit, owner.mayTerminateForUpdate, fenced else { print(owner.status); exit(1) }
 print(trace.joined(separator:","))
 `,
    ),
    ["install,authorize"],
  );
});
test("one-shot completion and explicit opt-out retain the disabled preference and cannot resume a staged update", (t) => {
  assert.deepEqual(
    run(
      t,
      `
 owner.setEnabled(false)
 try! owner.beginManualCheck()
 owner.cycleFinished(error: nil, upToDate: true)
 for _ in 0..<200 { if owner.canStartManualCheck { break }; try? await Task.sleep(for: .milliseconds(10)) }
 guard !owner.enabled, !owner.mayUpdate, owner.status.state == "disabled", owner.checkMessage == "You’re up to date." else { exit(1) }
 try! owner.beginManualCheck()
 guard owner.checkMessage == nil else { exit(1) }
 owner.candidate(version: "2")
 owner.ready(install: { trace.append("install") }, cancel: { trace.append("cancel") })
 try? await Task.sleep(for: .milliseconds(30))
 owner.setEnabled(false)
 owner.cycleFinished(error: nil)
 try? await Task.sleep(for: .milliseconds(30))
 blockers = []; owner.progress()
 guard !owner.enabled, !owner.mayUpdate, !fenced, !owner.mayTerminateForUpdate,
       owner.status.state == "disabled" else { print(owner.status); exit(1) }
 print(trace.joined(separator:","))
 `,
    ),
    ["cancel"],
  );
});
test("native intent leaves work usable while waiting; actual clean child exit precedes authorization", (t) => {
  assert.deepEqual(
    run(
      t,
      `
 guard case .ready(let pid, _) = observed else { exit(1) }
 owner.ready(install: { trace.append("install"); owner.installing {
     guard kill(pid, 0) != 0 else { trace.append("authorized-before-exit"); return }
     trace.append("authorize")
 } }, cancel: { trace.append("cancel") })
 try? await Task.sleep(for: .milliseconds(30))
 guard !fenced, trace.isEmpty else { print(trace); exit(1) }
 _ = try? await host.call("service.health")
 blockers = []; owner.progress()
 for _ in 0..<200 { if owner.mayTerminateForUpdate { break }; try? await Task.sleep(for: .milliseconds(10)) }
 guard fenced, owner.cleanServiceExit, owner.mayTerminateForUpdate else { print(owner.status); exit(1) }
 print(trace.joined(separator:","))
 `,
    ),
    ["install,authorize"],
  );
});

test("new native intent during service preparation releases the actual permit and does not install", (t) => {
  const delayed = peer.replace(
    "send({event:'result',response:{id:request.id,ok:true,data}});",
    "setTimeout(()=>send({event:'result',response:{id:request.id,ok:true,data}}), request.operation === 'update.prepare' ? 70 : 0);",
  );
  assert.deepEqual(
    run(
      t,
      `
 blockers = []
 owner.ready(install: { trace.append("install") }, cancel: { trace.append("cancel") })
 try? await Task.sleep(for: .milliseconds(20))
 blockers = ["native.permission"]; owner.progress()
 try? await Task.sleep(for: .milliseconds(140))
 guard trace.isEmpty, !fenced, owner.status.state == "waiting",
       owner.status.blockers == ["native.permission"] else { print(trace, fenced, owner.status); exit(1) }
 do { _ = try await host.call("service.health"); print("usable") } catch { print(error.code); exit(1) }
 `,
      delayed,
    ),
    ["usable"],
  );
});

test("opt-out after Install drains SDK cancellation before reopening and cannot authorize EOF", (t) => {
  assert.deepEqual(
    run(
      t,
      `
 blockers = []
 owner.ready(install: { trace.append("install") }, cancel: { trace.append("cancel") })
 try? await Task.sleep(for: .milliseconds(70))
 guard trace == ["install"], fenced else { print(trace); exit(1) }
 owner.setEnabled(false)
 owner.installing { trace.append("authorize") }
 guard fenced, !owner.cleanServiceExit else { print("reopened before cancellation"); exit(1) }
 owner.cycleFinished(error:nil)
 try? await Task.sleep(for: .milliseconds(40))
 guard !fenced, owner.status.state == "disabled", !owner.mayTerminateForUpdate else { print(owner.status); exit(1) }
 do { _ = try await host.call("service.health"); print(trace.joined(separator:",")) } catch { print(error.code); exit(1) }
 `,
    ),
    ["install,cancel"],
  );
});

test("lost release acknowledgement restarts the service and lowers the native fence", (t) => {
  const lost = peer.replace(
    "send({event:'result',response:{id:request.id,ok:true,data}});",
    "if (request.operation !== 'update.release') send({event:'result',response:{id:request.id,ok:true,data}});",
  );
  assert.deepEqual(
    run(
      t,
      `
 owner.restartService = { trace.append("restart") }
 blockers = []
 owner.ready(install: { trace.append("install") }, cancel: { trace.append("cancel") })
 try? await Task.sleep(for: .milliseconds(70))
 owner.setEnabled(false); owner.cycleFinished(error:nil)
 for _ in 0..<300 { if trace.contains("restart") { break }; try? await Task.sleep(for: .milliseconds(10)) }
 guard !fenced, owner.status.error == nil, !owner.cleanServiceExit else { print(owner.status, fenced); exit(1) }
 print(trace.filter { $0 == "restart" }.joined())
 `,
      lost,
    ),
    ["restart"],
  );
});

test("a service that never answers the permit request is ended and the update installs without it", (t) => {
  const silent = peer.replace(
    "if (request.operation === 'update.prepare') permit = 'permit';",
    "if (request.operation === 'update.prepare') return;",
  );
  assert.deepEqual(
    run(
      t,
      `
 blockers = []
 owner.ready(install: { trace.append("install"); owner.installing { trace.append("authorize") } },
             cancel: { trace.append("cancel") })
 for _ in 0..<1000 { if owner.mayTerminateForUpdate { break }; try? await Task.sleep(for: .milliseconds(10)) }
 guard owner.mayTerminateForUpdate, fenced else { print(owner.status, trace, fenced); exit(1) }
 do { _ = try await host.call("service.health"); print("service-still-running"); exit(1) } catch {}
 print(trace.joined(separator:","))
 `,
      silent,
    ),
    ["install,authorize"],
  );
});

test("a service that refuses the permit in three cycles running is ended and the update installs", (t) => {
  const refusing = peer.replace(
    "if (request.operation === 'update.prepare') permit = 'permit';",
    `if (request.operation === 'update.prepare') {
 send({event:'result',response:{id:request.id,ok:false,error:{code:'INTERNAL',message:'admission broke'}}}); return;
 }`,
  );
  assert.deepEqual(
    run(
      t,
      `
 blockers = []
 for cycle in 1...3 {
   owner.candidate(version: "2")
   owner.ready(install: { trace.append("install"); owner.installing { trace.append("authorize") } },
               cancel: { trace.append("cancel"); owner.cycleFinished(error: nil) })
   for _ in 0..<500 { if trace.count >= cycle || owner.mayTerminateForUpdate { break }; try? await Task.sleep(for: .milliseconds(10)) }
   try? await Task.sleep(for: .milliseconds(30))
   guard !fenced || owner.mayTerminateForUpdate else { print("fence left up", owner.status); exit(1) }
 }
 for _ in 0..<500 { if owner.mayTerminateForUpdate { break }; try? await Task.sleep(for: .milliseconds(10)) }
 guard owner.mayTerminateForUpdate else { print(owner.status, trace); exit(1) }
 print(trace.joined(separator:","))
 `,
      refusing,
    ),
    ["cancel,cancel,install,authorize"],
  );
});

test("an install that stops after the service closed restarts the service for the next cycle", (t) => {
  assert.deepEqual(
    run(
      t,
      `
 owner.restartService = { trace.append("restart") }
 blockers = []
 owner.ready(install: { trace.append("install"); owner.installing { trace.append("authorize") } },
             cancel: { trace.append("cancel") })
 for _ in 0..<300 { if owner.mayTerminateForUpdate { break }; try? await Task.sleep(for: .milliseconds(10)) }
 guard owner.mayTerminateForUpdate else { print(owner.status); exit(1) }
 owner.cycleFinished(error: ServiceFailure(code: "SDK_FAILURE", message: "replacement failed"))
 guard !owner.cleanServiceExit, !fenced, owner.canStartManualCheck || owner.status.state == "failed" else { print(owner.status, fenced); exit(1) }
 print(trace.joined(separator:","))
 `,
    ),
    ["install,authorize,restart"],
  );
});

test("service owner progress retries the idle join through the actual private control channel", (t) => {
  const busy = peer.replace("let permit;", "let permit; let busy = true;").replace(
    "if (request.operation === 'update.prepare') permit = 'permit';",
    `if (request.operation === 'update.prepare' && busy) {
  send({event:'result',response:{id:request.id,ok:true,data:{kind:'blocked',blockers:['jobs']}}});
  setTimeout(()=>{ busy = false; send({event:'update.progress'}); },30); return;
 }
 if (request.operation === 'update.prepare') permit = 'permit';`,
  );
  assert.deepEqual(
    run(
      t,
      `
 blockers = []; progress = { owner.progress() }
 owner.ready(install: { trace.append("install") }, cancel: { trace.append("cancel") })
 for _ in 0..<200 { if !trace.isEmpty { break }; try? await Task.sleep(for:.milliseconds(10)) }
 guard trace == ["install"], fenced else { print(owner.status); exit(1) }
 owner.setEnabled(false); owner.cycleFinished(error:nil)
 try? await Task.sleep(for:.milliseconds(40))
 guard !fenced else { print("cancellation failed"); exit(1) }
 print("owner-progress")
 `,
      busy,
    ),
    ["owner-progress"],
  );
});

test("failed commitment releases admission and completes the staged SDK cycle", (t) => {
  const denied = peer.replace("let permit;", "let permit; let denyCommit = true;").replace(
    "const data = request.operation === 'update.prepare'",
    `if (request.operation === 'update.commit' && denyCommit) {
 denyCommit = false;
 send({event:'result',response:{id:request.id,ok:false,error:{code:'INVALID_PERMIT',message:'permit expired'}}}); return;
 }
 const data = request.operation === 'update.prepare'`,
  );
  assert.deepEqual(
    run(
      t,
      `
 blockers = []
 owner.ready(install: { trace.append("install") }, cancel: { trace.append("cancel"); owner.cycleFinished(error:nil) })
 try? await Task.sleep(for:.milliseconds(90))
 guard trace == ["cancel"], !fenced else { print(trace,owner.status); exit(1) }
 do { _ = try await host.call("service.health") } catch { print(error.code); exit(1) }
 owner.candidate(version:"3")
 owner.ready(install: { trace.append("install") }, cancel: { trace.append("cancel") })
 try? await Task.sleep(for:.milliseconds(60))
 print(trace.joined(separator:","))
 owner.setEnabled(false); owner.cycleFinished(error:nil)
 try? await Task.sleep(for:.milliseconds(20))
 `,
      denied,
    ),
    ["cancel,install"],
  );
});

test("SDK failure before EOF releases service admission without claiming installer exclusion drained", (t) => {
  assert.deepEqual(
    run(
      t,
      `
 blockers = []
 owner.ready(install: { trace.append("install") }, cancel: { trace.append("cancel") })
 try? await Task.sleep(for:.milliseconds(60))
 owner.cycleFinished(error:ServiceFailure(code:"SDK_FAILURE",message:"launch reader is busy"))
 try? await Task.sleep(for:.milliseconds(40))
 guard !fenced, !owner.cleanServiceExit, owner.status.error?.code == "UPDATE_FAILED" else { print(owner.status,fenced); exit(1) }
 do { _ = try await host.call("service.health"); print("old-service-usable") } catch { print(error.code); exit(1) }
 `,
    ),
    ["old-service-usable"],
  );
});
test("a failed service cannot hold an update: it installs once native work is idle", (t) => {
  assert.deepEqual(
    run(
      t,
      `
 owner.serviceUnavailable()
 owner.ready(install: { trace.append("install"); owner.installing { trace.append("authorize") } },
             cancel: { trace.append("cancel") })
 try? await Task.sleep(for: .milliseconds(30))
 guard trace.isEmpty, !fenced, owner.status.state == "waiting" else { print(owner.status); exit(1) }
 blockers = []; owner.progress()
 for _ in 0..<200 { if owner.mayTerminateForUpdate { break }; try? await Task.sleep(for: .milliseconds(10)) }
 guard owner.mayTerminateForUpdate, fenced else { print(owner.status); exit(1) }
 print(trace.joined(separator:","))
 `,
    ),
    ["install,authorize"],
  );
});

test("a service ended for an update is restarted when that update does not install", (t) => {
  const silent = peer.replace(
    "if (request.operation === 'update.prepare') permit = 'permit';",
    "if (request.operation === 'update.prepare') return;",
  );
  assert.deepEqual(
    run(
      t,
      `
 owner.restartService = { trace.append("restart") }
 blockers = []
 owner.ready(install: { trace.append("install") }, cancel: { trace.append("cancel"); owner.cycleFinished(error: nil) })
 try? await Task.sleep(for: .milliseconds(100))
 blockers = ["native.capture"]
 for _ in 0..<300 { if (try? await host.call("service.health")) == nil { break }; try? await Task.sleep(for: .milliseconds(10)) }
 try? await Task.sleep(for: .milliseconds(100))
 guard trace.isEmpty else { print("installed under a take", trace); exit(1) }
 owner.setEnabled(false)
 for _ in 0..<300 { if trace.contains("restart") { break }; try? await Task.sleep(for: .milliseconds(10)) }
 print(trace.joined(separator:","))
 `,
      silent,
    ),
    ["cancel,restart"],
  );
});

test("a service that exits uncleanly while closing for an install is restarted, never bypassed", (t) => {
  const unclean = peer.replace(".on('close',()=>process.exit(0))", ".on('close',()=>process.exit(1))");
  assert.deepEqual(
    run(
      t,
      `
 owner.restartService = { trace.append("restart") }
 blockers = []
 // As the app does: the host reports "closing for update" as unavailable, and that reaches the owner.
 owner.ready(install: { trace.append("install"); owner.installing { trace.append("authorize") }; owner.serviceUnavailable() },
             cancel: { trace.append("cancel"); owner.cycleFinished(error: nil) })
 for _ in 0..<500 { if trace.contains("restart") { break }; try? await Task.sleep(for: .milliseconds(10)) }
 try? await Task.sleep(for: .milliseconds(50))
 guard !owner.mayTerminateForUpdate, !fenced else { print(owner.status, fenced); exit(1) }
 owner.candidate(version: "3")
 owner.ready(install: { trace.append("install-without-permit") }, cancel: { trace.append("cancel") })
 try? await Task.sleep(for: .milliseconds(100))
 print(trace.joined(separator:","))
 `,
      unclean,
    ),
    ["install,restart,cancel"],
  );
});

test("refusals count only when consecutive from the same service", (t) => {
  const refusing = peer.replace(
    "if (request.operation === 'update.prepare') permit = 'permit';",
    `if (request.operation === 'update.prepare') {
 send({event:'result',response:{id:request.id,ok:false,error:{code:'INTERNAL',message:'admission broke'}}}); return;
 }`,
  );
  assert.deepEqual(
    run(
      t,
      `
 blockers = []
 for cycle in 1...3 {
   if cycle == 3 { owner.attach(to: host) } // a fresh service starts its own count
   owner.candidate(version: "2")
   owner.ready(install: { trace.append("install") },
               cancel: { trace.append("cancel"); owner.cycleFinished(error: nil) })
   for _ in 0..<500 { if trace.count >= cycle { break }; try? await Task.sleep(for: .milliseconds(10)) }
   try? await Task.sleep(for: .milliseconds(30))
 }
 do { _ = try await host.call("service.health") } catch { print("service ended"); exit(1) }
 print(trace.joined(separator:","))
 `,
      refusing,
    ),
    ["cancel,cancel,cancel"],
  );
});
