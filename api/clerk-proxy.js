const PROXY_URL = "https://invoice-chasing.vercel.app/__clerk";
const CLERK_FRONTEND_API = "https://frontend-api.clerk.dev";

export default async function handler(request, response) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    response.status(500).json({ error: "Clerk proxy is not configured" });
    return;
  }

  const path = Array.isArray(request.query.path)
    ? request.query.path.join("/")
    : String(request.query.path || "");
  const incomingUrl = new URL(request.url, `https://${request.headers.host}`);
  const target = new URL(`${CLERK_FRONTEND_API}/${path}`);
  target.search = incomingUrl.searchParams.get("query") || "";

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (name.toLowerCase() !== "host" && name.toLowerCase() !== "content-length") {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  headers.set("Accept-Encoding", "identity");
  headers.set("Clerk-Proxy-Url", PROXY_URL);
  headers.set("Clerk-Secret-Key", secretKey);
  const forwardedFor = request.headers["x-forwarded-for"] || request.headers["x-real-ip"] || "";
  if (forwardedFor) headers.set("X-Forwarded-For", Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor);

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    duplex: "half",
  });

  response.status(upstream.status);
  upstream.headers.forEach((value, name) => {
    if (!['connection', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())) response.setHeader(name, value);
  });
  response.send(Buffer.from(await upstream.arrayBuffer()));
}
