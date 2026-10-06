// Pure decision for ops-agent-log: send the PR approve card only for a real PR, and only the FIRST time that PR is
// logged (a later run that finds the same open PR must not ping the owner again). A failed "was it logged?" read
// (priorLogged null) sends the card — a duplicate card is harmless, a missing one hides the PR.
export function shouldSendPrCard(outcomeType: string, pr: number | null, priorLogged: number | null): boolean {
  if (outcomeType !== "pr" || !pr) return false;
  return priorLogged === null || priorLogged === 0;
}
