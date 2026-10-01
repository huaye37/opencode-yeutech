import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Generate an image with the YEUTECH image plugin and save it under the current project or standalone conversation's 产出/YYYY-MM-DD folder. Use this whenever the user asks to create or generate an image.",
  args: {
    prompt: tool.schema.string().min(1).max(20000).describe("Detailed image generation prompt"),
    model: tool.schema.string().optional().describe("Optional image model ID; omit to use the first currently ready image model"),
    size: tool.schema.enum(["auto", "1024x1024", "1024x1536", "1536x1024"]).optional(),
    quality: tool.schema.enum(["auto", "low", "medium", "high"]).optional(),
  },
  async execute(args, context) {
    const endpoint = process.env.YEUTECH_PLUGIN_GATEWAY_URL || "http://127.0.0.1:18140"
    const token = process.env.YEUTECH_PLUGIN_SERVICE_TOKEN
    if (!token) throw new Error("YEUTECH image plugin token is unavailable")
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(args))))).slice(0, 12).map((value) => value.toString(16).padStart(2, "0")).join("")
    const response = await fetch(new URL("/api/plugins/v1/image-generation/agent-runs", endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...args, sessionId: context.sessionID, idempotencyKey: `${context.sessionID}:${context.messageID}:${digest}` }),
      signal: context.abort,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(payload?.error?.message || `YEUTECH image plugin failed (${response.status})`)
    return JSON.stringify({ type: "yeutech.image", ...payload.data })
  },
})
