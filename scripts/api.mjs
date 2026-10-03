// Tiny dev helper: node scripts/api.mjs METHOD /path ['{"json":"body"}']
// Talks to the locally running ERP (PORT env, default 5055). Not used by the app.
const [, , method = "GET", path = "/health", body] = process.argv;
const port = process.env.PORT || 5055;
const max = Number(process.env.MAX || 1800);
try {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body || undefined,
    signal: AbortSignal.timeout(90_000)
  });
  console.log(r.status, (await r.text()).slice(0, max));
} catch (e) {
  console.log("ERR", e.cause?.code || e.message);
}
