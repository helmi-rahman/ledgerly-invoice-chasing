import { clerkFrontendApiProxy } from "@clerk/backend/proxy";

export const config = {
  runtime: "edge",
};

export default function handler(request) {
  return clerkFrontendApiProxy(request, {
    proxyPath: "/__clerk",
    publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY,
    secretKey: process.env.CLERK_SECRET_KEY,
  });
}
