// Test-only loader that routes the manual publisher's HTTPS origin to the local HTTP server running the real
// Worker. Any other origin throws, so a test cannot upload remotely.
const originalFetch = globalThis.fetch;

const localOrigin = process.env.FAKE_UPDATE_ORIGIN;

if (!localOrigin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(localOrigin))
  throw new Error("Missing local test Worker origin");

globalThis.fetch = (input, init) => {
  const url = new URL(input);

  if (url.origin !== "https://permitmon-updates.example.test") throw new Error("Unexpected publisher origin");

  return originalFetch(new URL(`${url.pathname}${url.search}`, localOrigin), init);
};
