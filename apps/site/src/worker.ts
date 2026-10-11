export const worker = {
  fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.hostname === "www.localdot.dev" ||
      (url.hostname === "localdot.dev" && url.protocol !== "https:")
    ) {
      url.protocol = "https:";
      url.hostname = "localdot.dev";
      url.port = "";
      return Response.redirect(url.href, 308);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// biome-ignore lint/style/noDefaultExport: Cloudflare requires a default module Worker entrypoint.
export default worker;
