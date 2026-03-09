import { mutation, query } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { v } from "convex/values";

// ─── Helpers ─────────────────────────────────────────────────────

function generateSecret(): string {
  const chars = "abcdef0123456789";
  let result = "whsec_";
  for (let i = 0; i < 64; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// ─── Destination Management ──────────────────────────────────────

/**
 * Register a new webhook destination URL.
 * Generates an HMAC signing secret for payload verification.
 */
export const registerDestination = mutation({
  args: {
    url: v.string(),
    deliveryMode: v.optional(v.string()),
    maxRetries: v.optional(v.number()),
    retryWindowMs: v.optional(v.number()),
    rateLimitPerSecond: v.optional(v.number()),
    secret: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  returns: v.object({
    destinationId: v.string(),
    secret: v.string(),
  }),
  handler: async (ctx, args) => {
    const secret = args.secret ?? generateSecret();

    const id = await ctx.db.insert("destinations", {
      url: args.url,
      secret,
      deliveryMode: args.deliveryMode ?? "parallel",
      maxRetries: args.maxRetries ?? 5,
      retryWindowMs: args.retryWindowMs ?? 24 * 60 * 60 * 1000, // 24h default
      rateLimitPerSecond: args.rateLimitPerSecond,
      active: true,
      metadata: args.metadata,
      createdAt: Date.now(),
    });

    return { destinationId: id as string, secret };
  },
});

/**
 * Remove (deactivate) a destination.
 */
export const removeDestination = mutation({
  args: { destinationId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    try {
      const dest = await ctx.db.get(args.destinationId as any);
      if (!dest) return false;
      await ctx.db.patch(dest._id, { active: false });
      return true;
    } catch {
      return false;
    }
  },
});

/**
 * Update destination configuration.
 */
export const updateDestination = mutation({
  args: {
    destinationId: v.string(),
    url: v.optional(v.string()),
    deliveryMode: v.optional(v.string()),
    maxRetries: v.optional(v.number()),
    retryWindowMs: v.optional(v.number()),
    rateLimitPerSecond: v.optional(v.number()),
    active: v.optional(v.boolean()),
    metadata: v.optional(v.any()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    try {
      const dest = await ctx.db.get(args.destinationId as any);
      if (!dest) return false;

      const updates: any = {};
      if (args.url !== undefined) updates.url = args.url;
      if (args.deliveryMode !== undefined) updates.deliveryMode = args.deliveryMode;
      if (args.maxRetries !== undefined) updates.maxRetries = args.maxRetries;
      if (args.retryWindowMs !== undefined) updates.retryWindowMs = args.retryWindowMs;
      if (args.rateLimitPerSecond !== undefined) updates.rateLimitPerSecond = args.rateLimitPerSecond;
      if (args.active !== undefined) updates.active = args.active;
      if (args.metadata !== undefined) updates.metadata = args.metadata;

      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(dest._id, updates);
      }
      return true;
    } catch {
      return false;
    }
  },
});

// ─── Webhook Queuing ─────────────────────────────────────────────

/**
 * Queue a webhook for delivery.
 * Automatically schedules the delivery action.
 */
export const queueWebhook = mutation({
  args: {
    destinationId: v.string(),
    eventType: v.string(),
    payload: v.any(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    // Verify destination exists and is active
    let dest: any;
    try {
      dest = await ctx.db.get(args.destinationId as any);
    } catch {
      return null;
    }
    if (!dest || !dest.active) return null;

    // For serialized mode, check if there's an in-flight webhook
    if (dest.deliveryMode === "serialized") {
      const inflight = await ctx.db
        .query("webhooks")
        .withIndex("by_destination_status", (q: any) =>
          q.eq("destinationId", args.destinationId).eq("status", "delivering")
        )
        .first();

      // If something is in-flight, queue as pending (will be picked up after current delivery)
      if (inflight) {
        const id = await ctx.db.insert("webhooks", {
          destinationId: args.destinationId,
          eventType: args.eventType,
          payload: args.payload,
          status: "pending",
          createdAt: Date.now(),
          retryCount: 0,
          maxRetries: dest.maxRetries,
          retryWindowMs: dest.retryWindowMs,
        });
        return id as string;
      }
    }

    // Create webhook and schedule immediate delivery
    const id = await ctx.db.insert("webhooks", {
      destinationId: args.destinationId,
      eventType: args.eventType,
      payload: args.payload,
      status: "pending",
      createdAt: Date.now(),
      retryCount: 0,
      maxRetries: dest.maxRetries,
      retryWindowMs: dest.retryWindowMs,
    });

    // Schedule delivery action
    await ctx.scheduler.runAfter(0, internal.delivery.deliver, {
      webhookId: id as string,
    });

    return id as string;
  },
});

// ─── Queries ─────────────────────────────────────────────────────

/**
 * Get destination details.
 */
export const getDestination = query({
  args: { destinationId: v.string() },
  returns: v.union(
    v.object({
      destinationId: v.string(),
      url: v.string(),
      deliveryMode: v.string(),
      maxRetries: v.number(),
      retryWindowMs: v.number(),
      rateLimitPerSecond: v.optional(v.number()),
      active: v.boolean(),
      metadata: v.optional(v.any()),
      createdAt: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    try {
      const dest = await ctx.db.get(args.destinationId as any);
      if (!dest) return null;
      return {
        destinationId: dest._id as string,
        url: dest.url,
        deliveryMode: dest.deliveryMode,
        maxRetries: dest.maxRetries,
        retryWindowMs: dest.retryWindowMs,
        rateLimitPerSecond: dest.rateLimitPerSecond,
        active: dest.active,
        metadata: dest.metadata,
        createdAt: dest.createdAt,
      };
    } catch {
      return null;
    }
  },
});

/**
 * List all registered destinations.
 */
export const listDestinations = query({
  args: { activeOnly: v.optional(v.boolean()) },
  returns: v.array(
    v.object({
      destinationId: v.string(),
      url: v.string(),
      deliveryMode: v.string(),
      active: v.boolean(),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    let dests = await ctx.db.query("destinations").collect();
    if (args.activeOnly) {
      dests = dests.filter((d: any) => d.active);
    }
    return dests.map((d: any) => ({
      destinationId: d._id as string,
      url: d.url,
      deliveryMode: d.deliveryMode,
      active: d.active,
      createdAt: d.createdAt,
    }));
  },
});

/**
 * Get the signing secret for a destination.
 * Share this with the recipient so they can verify webhook signatures.
 */
export const getSigningSecret = query({
  args: { destinationId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    try {
      const dest = await ctx.db.get(args.destinationId as any);
      return dest?.secret ?? null;
    } catch {
      return null;
    }
  },
});

/**
 * Get the status of a specific webhook.
 */
export const getWebhookStatus = query({
  args: { webhookId: v.string() },
  returns: v.union(
    v.object({
      webhookId: v.string(),
      destinationId: v.string(),
      eventType: v.string(),
      status: v.string(),
      createdAt: v.number(),
      deliveredAt: v.optional(v.number()),
      nextRetryAt: v.optional(v.number()),
      retryCount: v.number(),
      maxRetries: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    try {
      const wh = await ctx.db.get(args.webhookId as any);
      if (!wh) return null;
      return {
        webhookId: wh._id as string,
        destinationId: wh.destinationId,
        eventType: wh.eventType,
        status: wh.status,
        createdAt: wh.createdAt,
        deliveredAt: wh.deliveredAt,
        nextRetryAt: wh.nextRetryAt,
        retryCount: wh.retryCount,
        maxRetries: wh.maxRetries,
      };
    } catch {
      return null;
    }
  },
});

/**
 * Get delivery history for a destination with pagination.
 */
export const getDeliveryHistory = query({
  args: {
    destinationId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      attemptId: v.string(),
      webhookId: v.string(),
      timestamp: v.number(),
      statusCode: v.optional(v.number()),
      error: v.optional(v.string()),
      success: v.boolean(),
    })
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const attempts = await ctx.db
      .query("deliveryAttempts")
      .withIndex("by_destination", (q: any) =>
        q.eq("destinationId", args.destinationId)
      )
      .order("desc")
      .take(limit);

    return attempts.map((a: any) => ({
      attemptId: a._id as string,
      webhookId: a.webhookId,
      timestamp: a.timestamp,
      statusCode: a.statusCode,
      error: a.error,
      success: a.success,
    }));
  },
});

/**
 * Get all failed webhooks for a destination.
 */
export const getFailedWebhooks = query({
  args: {
    destinationId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      webhookId: v.string(),
      eventType: v.string(),
      status: v.string(),
      createdAt: v.number(),
      retryCount: v.number(),
      maxRetries: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const failed = await ctx.db
      .query("webhooks")
      .withIndex("by_destination_status", (q: any) =>
        q.eq("destinationId", args.destinationId).eq("status", "failed")
      )
      .take(limit);

    return failed.map((w: any) => ({
      webhookId: w._id as string,
      eventType: w.eventType,
      status: w.status,
      createdAt: w.createdAt,
      retryCount: w.retryCount,
      maxRetries: w.maxRetries,
    }));
  },
});
