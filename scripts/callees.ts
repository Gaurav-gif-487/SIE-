import path from "node:path";
import { Engine } from "../src/engine/engine.js";
const e = new Engine(path.resolve(import.meta.dirname, "../tests/fixtures/repo-b"));
for (const s of ["invokeGeneric","invokeAlias","invokeUnrelated","invokeInherited","makeHandler","viaBind","viaCallback"]) {
  const r = await e.findCallees(s);
  console.log(s, JSON.stringify({
    conf: r.result.confirmed.map(c=>[c.calleeName,c.callSite.line]),
    poss: r.result.possible.map(c=>[c.calleeName,c.callSite.line,c.dispatch]),
    open: r.result.unresolvedSites.map(c=>[c.calleeText,c.callSite.line]),
    ext: r.result.externalCallees.map(c=>[c.text,c.callSite.line]),
    u: r.uncertainty.value,
  }));
}
