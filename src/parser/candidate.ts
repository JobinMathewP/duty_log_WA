const lineLabel = (name: string): RegExp =>
  new RegExp(`^[^\\S\\r\\n]*${name}\\s*[:\\-]`, "im");

const hasSite = lineLabel("site");
const hasStart = lineLabel("start\\s*duty");
const hasFinish = lineLabel("finish\\s*duty");
const hasTotal = lineLabel("total(?:\\s*working)?\\s*hrs?");

/** A message is a duty log only when the labeled lines are present. Chat that merely mentions a site is ignored. */
export function isDutyCandidate(body: string): boolean {
  const site = hasSite.test(body);
  const start = hasStart.test(body);
  const finish = hasFinish.test(body);
  const total = hasTotal.test(body);
  if (site && (start || finish || total)) return true;
  if (start && finish) return true;
  return false;
}
