import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { v } from "convex/values";

// ─── HMAC-SHA256 Signing ────────────────────────────────────────

async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  // Strip whsec_ prefix if present
  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyData = encoder.encode(rawSecret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  // Convert to base64
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ─── Internal Query ─────────────────────────────────────────────

export const getDeliveryData = internalQuery({
  args: { webhookId: v.string() },
  returns: v.union(
    v.object({
      webhook: v.object({
        _id: v.string(),
        destinationId: v.string(),
        eventType: v.string(),
        payload: v.any(),
        status: v.string(),
        createdAt: v.number(),
        retryCount: v.number(),
        maxRetries: v.number(),
        retryWindowMs: v.number(),
      }),
      destination: v.object({
        _id: v.string(),
        url: v.string(),
        secret: v.string(),
        deliveryMode: v.string(),
        active: v.boolean(),
      }),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    try {
      const wh = await ctx.db.get(args.webhookId as any);
      if (!wh) return null;

      const dest = await ctx.db.get(wh.destinationId as any);
      if (!dest) return null;

      return {
        webhook: {
          _id: wh._id as string,
          destinationId: wh.destinationId,
          eventType: wh.eventType,
          payload: wh.payload,
          status: wh.status,
          createdAt: wh.createdAt,
          retryCount: wh.retryCount,
          maxRetries: wh.maxRetries,
          retryWindowMs: wh.retryWindowMs,
        },
        destination: {
          _id: dest._id as string,
          url: dest.url,
          secret: dest.secret,
          deliveryMode: dest.deliveryMode,
          active: dest.active,
        },
      };
    } catch {
      return null;
    }
  },
});

// ─── Internal Mutation: Record Result ───────────────────────────

export const recordResult = internalMutation({
  args: {
    webhookId: v.string(),
    destinationId: v.string(),
    success: v.boolean(),
    statusCode: v.optional(v.number()),
    error: v.optional(v.string()),
    deliveryMode: v.string(),
    retryCount: v.number(),
    maxRetries: v.number(),
    retryWindowMs: v.number(),
    createdAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();

    // Record the delivery attempt
    await ctx.db.insert("deliveryAttempts", {
      webhookId: args.webhookId,
      destinationId: args.destinationId,
      timestamp: now,
      statusCode: args.statusCode,
      error: args.error,
      success: args.success,
    });

    // Update webhook status
    try {
      const wh = await ctx.db.get(args.webhookId as any);
      if (!wh) return null;

      if (args.success) {
        await ctx.db.patch(wh._id, {
          status: "delivered",
          deliveredAt: now,
        });
      } else {
        const newRetryCount = args.retryCount + 1;
        const withinWindow = now - args.createdAt < args.retryWindowMs;

        if (newRetryCount >= args.maxRetries || !withinWindow) {
          // Max retries reached or outside retry window
          await ctx.db.patch(wh._id, { status: "failed", retryCount: newRetryCount });
        } else {
          // Schedule retry with exponential backoff: 1s, 2s, 4s, 8s, 16s...
          const backoffMs = Math.min(1000 * Math.pow(2, newRetryCount - 1), 60 * 60 * 1000); // cap at 1 hour
          const nextRetryAt = now + backoffMs;

          await ctx.db.patch(wh._id, {
            status: "retrying",
            retryCount: newRetryCount,
            nextRetryAt,
          });

          // Schedule retry
          await ctx.scheduler.runAfter(backoffMs, internal.delivery.deliver, {
            webhookId: args.webhookId,
          });
        }
      }

      // For serialized mode: pick up next pending webhook
      if (args.deliveryMode === "serialized" && args.success) {
        const next = await ctx.db
          .query("webhooks")
          .withIndex("by_destination_status", (q: any) =>
            q.eq("destinationId", args.destinationId).eq("status", "pending")
          )
          .order("asc")
          .first();

        if (next) {
          await ctx.scheduler.runAfter(0, internal.delivery.deliver, {
            webhookId: next._id as string,
          });
        }
      }
    } catch {
      // Webhook may have been deleted
    }

    return null;
  },
});

// ─── Internal Action: Deliver Webhook ───────────────────────────

export const deliver = internalAction({
  args: { webhookId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Fetch webhook + destination data
    const data: any = await ctx.runQuery(internal.delivery.getDeliveryData, {
      webhookId: args.webhookId,
    });

    if (!data) return null;

    const { webhook, destination } = data;

    // Don't deliver to inactive destinations
    if (!destination.active) {
      await ctx.runMutation(internal.delivery.recordResult, {
        webhookId: webhook._id,
        destinationId: webhook.destinationId,
        success: false,
        error: "Destination is inactive",
        deliveryMode: destination.deliveryMode,
        retryCount: webhook.retryCount,
        maxRetries: webhook.maxRetries,
        retryWindowMs: webhook.retryWindowMs,
        createdAt: webhook.createdAt,
      });
      return null;
    }

    // Build the payload
    const timestamp = Math.floor(Date.now() / 1000);
    const msgId = `msg_${webhook._id}`;
    const body = JSON.stringify({
      type: webhook.eventType,
      timestamp,
      data: webhook.payload,
    });

    // Sign the payload: "msgId.timestamp.body"
    const toSign = `${msgId}.${timestamp}.${body}`;
    let signature: string;
    try {
      signature = await signPayload(toSign, destination.secret);
    } catch (err: any) {
      await ctx.runMutation(internal.delivery.recordResult, {
        webhookId: webhook._id,
        destinationId: webhook.destinationId,
        success: false,
        error: `Signing failed: ${err.message}`,
        deliveryMode: destination.deliveryMode,
        retryCount: webhook.retryCount,
        maxRetries: webhook.maxRetries,
        retryWindowMs: webhook.retryWindowMs,
        createdAt: webhook.createdAt,
      });
      return null;
    }

    // Deliver via HTTP POST
    let statusCode: number | undefined;
    let error: string | undefined;
    let success = false;

    try {
      const response = await fetch(destination.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "webhook-id": msgId,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": `v1,${signature}`,
        },
        body,
        signal: AbortSignal.timeout(30000), // 30s timeout
      });

      statusCode = response.status;
      success = statusCode >= 200 && statusCode < 300;
      if (!success) {
        error = `HTTP ${statusCode}`;
      }
    } catch (err: any) {
      error = err.message || "Network error";
    }

    // Record the result
    await ctx.runMutation(internal.delivery.recordResult, {
      webhookId: webhook._id,
      destinationId: webhook.destinationId,
      success,
      statusCode,
      error,
      deliveryMode: destination.deliveryMode,
      retryCount: webhook.retryCount,
      maxRetries: webhook.maxRetries,
      retryWindowMs: webhook.retryWindowMs,
      createdAt: webhook.createdAt,
    });

    return null;
  },
});
