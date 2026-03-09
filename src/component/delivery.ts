import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { v } from "convex/values";

// ─── Helpers ────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ─── Ed25519 Key Generation (Internal Action) ──────────────────

export const generateKeyPair = internalAction({
  args: { destinationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const keyPair = await crypto.subtle.generateKey("Ed25519", true, [
        "sign",
        "verify",
      ]);

      const privateKeyBuffer = await crypto.subtle.exportKey(
        "pkcs8",
        keyPair.privateKey
      );
      const publicKeyBuffer = await crypto.subtle.exportKey(
        "spki",
        keyPair.publicKey
      );

      const privateKey = arrayBufferToBase64(privateKeyBuffer);
      const publicKey = arrayBufferToBase64(publicKeyBuffer);

      await ctx.runMutation(internal.delivery.storeKeyPair, {
        destinationId: args.destinationId,
        privateKey,
        publicKey,
      });
    } catch (err: any) {
      // Ed25519 not supported in this runtime — HMAC fallback will be used
      console.warn(
        `Ed25519 key generation failed for ${args.destinationId}: ${err.message}. HMAC signing will be used as fallback.`
      );
    }
    return null;
  },
});

export const storeKeyPair = internalMutation({
  args: {
    destinationId: v.string(),
    privateKey: v.string(),
    publicKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const dest = await ctx.db.get(args.destinationId as any);
      if (dest) {
        await ctx.db.patch(dest._id, {
          privateKey: args.privateKey,
          publicKey: args.publicKey,
        });
      }
    } catch {
      // Destination may have been deleted
    }
    return null;
  },
});

// ─── URL Validation (Internal Action) ───────────────────────────

export const validateUrl = internalAction({
  args: { destinationId: v.string(), url: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    let reachable = false;
    try {
      const response = await fetch(args.url, {
        method: "HEAD",
        signal: AbortSignal.timeout(10000),
      });
      reachable = response.status < 500;
    } catch {
      reachable = false;
    }

    await ctx.runMutation(internal.delivery.markUrlValidated, {
      destinationId: args.destinationId,
      validated: reachable,
    });
    return null;
  },
});

export const markUrlValidated = internalMutation({
  args: { destinationId: v.string(), validated: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const dest = await ctx.db.get(args.destinationId as any);
      if (dest) {
        await ctx.db.patch(dest._id, { urlValidated: args.validated });
      }
    } catch {
      // Destination may have been deleted
    }
    return null;
  },
});

// ─── Rate Limit Check ───────────────────────────────────────────

export const checkRateLimit = internalQuery({
  args: { destinationId: v.string(), windowStart: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const attempts = await ctx.db
      .query("deliveryAttempts")
      .withIndex("by_destination", (q: any) =>
        q
          .eq("destinationId", args.destinationId)
          .gte("timestamp", args.windowStart)
      )
      .collect();
    return attempts.length;
  },
});

// ─── Internal Query: Get Delivery Data ──────────────────────────

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
        rateLimitPerSecond: v.optional(v.number()),
        privateKey: v.optional(v.string()),
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
          rateLimitPerSecond: dest.rateLimitPerSecond,
          privateKey: dest.privateKey,
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
          await ctx.db.patch(wh._id, {
            status: "failed",
            retryCount: newRetryCount,
          });
        } else {
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s... capped at 1 hour
          const backoffMs = Math.min(
            1000 * Math.pow(2, newRetryCount - 1),
            60 * 60 * 1000
          );
          const nextRetryAt = now + backoffMs;

          await ctx.db.patch(wh._id, {
            status: "retrying",
            retryCount: newRetryCount,
            nextRetryAt,
          });

          await ctx.scheduler.runAfter(backoffMs, internal.delivery.deliver, {
            webhookId: args.webhookId,
          });
        }
      }

      // For serialized mode: pick up next pending webhook after success
      if (args.deliveryMode === "serialized" && args.success) {
        const next = await ctx.db
          .query("webhooks")
          .withIndex("by_destination_status", (q: any) =>
            q
              .eq("destinationId", args.destinationId)
              .eq("status", "pending")
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

async function signWithEd25519(
  payload: string,
  privateKeyBase64: string
): Promise<string> {
  const privateKeyBuffer = base64ToArrayBuffer(privateKeyBase64);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBuffer,
    "Ed25519",
    false,
    ["sign"]
  );
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key,
    encoder.encode(payload)
  );
  return arrayBufferToBase64(signature);
}

async function signWithHmac(
  payload: string,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(rawSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );
  return arrayBufferToBase64(signature);
}

export const deliver = internalAction({
  args: { webhookId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
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

    // ── Rate limit check ──
    if (destination.rateLimitPerSecond) {
      const windowStart = Date.now() - 1000;
      const recentCount: number = await ctx.runQuery(
        internal.delivery.checkRateLimit,
        {
          destinationId: webhook.destinationId,
          windowStart,
        }
      );
      if (recentCount >= destination.rateLimitPerSecond) {
        // Delay delivery by 1 second
        await ctx.scheduler.runAfter(1000, internal.delivery.deliver, {
          webhookId: args.webhookId,
        });
        return null;
      }
    }

    // ── Build payload ──
    const timestamp = Math.floor(Date.now() / 1000);
    const msgId = `msg_${webhook._id}`;
    const body = JSON.stringify({
      type: webhook.eventType,
      timestamp,
      data: webhook.payload,
    });

    // ── Sign payload ──
    const toSign = `${msgId}.${timestamp}.${body}`;
    let signature: string;
    let signatureScheme: string;

    try {
      if (destination.privateKey) {
        // Ed25519 asymmetric signing (preferred)
        signature = await signWithEd25519(toSign, destination.privateKey);
        signatureScheme = "ed25519";
      } else {
        // HMAC-SHA256 fallback
        signature = await signWithHmac(toSign, destination.secret);
        signatureScheme = "v1";
      }
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

    // ── Deliver via HTTP POST ──
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
          "webhook-signature": `${signatureScheme},${signature}`,
        },
        body,
        signal: AbortSignal.timeout(30000),
      });

      statusCode = response.status;
      success = statusCode >= 200 && statusCode < 300;
      if (!success) {
        error = `HTTP ${statusCode}`;
      }
    } catch (err: any) {
      error = err.message || "Network error";
    }

    // ── Record result ──
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
