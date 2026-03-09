import {
  FunctionReference,
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";

// ─── Types ──────────────────────────────────────────────────────

type RunMutationCtx = {
  runMutation: GenericMutationCtx<any>["runMutation"];
};

type RunQueryCtx = {
  runQuery: GenericQueryCtx<any>["runQuery"];
};

export interface DestinationConfig {
  url: string;
  deliveryMode?: "serialized" | "parallel";
  maxRetries?: number;
  retryWindowMs?: number;
  rateLimitPerSecond?: number;
  secret?: string;
  metadata?: any;
}

export interface DestinationResult {
  destinationId: string;
  secret: string;
}

export interface DestinationInfo {
  destinationId: string;
  url: string;
  deliveryMode: string;
  maxRetries: number;
  retryWindowMs: number;
  rateLimitPerSecond?: number;
  active: boolean;
  metadata?: any;
  createdAt: number;
}

export interface DestinationListItem {
  destinationId: string;
  url: string;
  deliveryMode: string;
  active: boolean;
  createdAt: number;
}

export interface WebhookStatus {
  webhookId: string;
  destinationId: string;
  eventType: string;
  status: string;
  createdAt: number;
  deliveredAt?: number;
  nextRetryAt?: number;
  retryCount: number;
  maxRetries: number;
}

export interface DeliveryAttempt {
  attemptId: string;
  webhookId: string;
  timestamp: number;
  statusCode?: number;
  error?: string;
  success: boolean;
}

export interface FailedWebhook {
  webhookId: string;
  eventType: string;
  status: string;
  createdAt: number;
  retryCount: number;
  maxRetries: number;
}

// ─── Client Class ───────────────────────────────────────────────

export class WebhookSender {
  public component: UseApi<typeof import("../component/_generated/api.js").api>;

  constructor(
    component: UseApi<typeof import("../component/_generated/api.js").api>
  ) {
    this.component = component;
  }

  /**
   * Register a new webhook destination URL.
   * Returns the destination ID and HMAC signing secret.
   */
  async registerDestination(
    ctx: RunMutationCtx,
    config: DestinationConfig
  ): Promise<DestinationResult> {
    return await ctx.runMutation(this.component.public.registerDestination, {
      url: config.url,
      deliveryMode: config.deliveryMode,
      maxRetries: config.maxRetries,
      retryWindowMs: config.retryWindowMs,
      rateLimitPerSecond: config.rateLimitPerSecond,
      secret: config.secret,
      metadata: config.metadata,
    });
  }

  /**
   * Remove (deactivate) a webhook destination.
   */
  async removeDestination(
    ctx: RunMutationCtx,
    destinationId: string
  ): Promise<boolean> {
    return await ctx.runMutation(this.component.public.removeDestination, {
      destinationId,
    });
  }

  /**
   * Update a destination's configuration.
   */
  async updateDestination(
    ctx: RunMutationCtx,
    destinationId: string,
    updates: Partial<Omit<DestinationConfig, "secret">> & { active?: boolean }
  ): Promise<boolean> {
    return await ctx.runMutation(this.component.public.updateDestination, {
      destinationId,
      ...updates,
    });
  }

  /**
   * Queue a webhook for delivery.
   * Returns the webhook ID, or null if destination is invalid/inactive.
   */
  async send(
    ctx: RunMutationCtx,
    args: { destinationId: string; eventType: string; payload: any }
  ): Promise<string | null> {
    return await ctx.runMutation(this.component.public.queueWebhook, args);
  }

  /**
   * Get destination details.
   */
  async getDestination(
    ctx: RunQueryCtx,
    destinationId: string
  ): Promise<DestinationInfo | null> {
    return await ctx.runQuery(this.component.public.getDestination, {
      destinationId,
    });
  }

  /**
   * List all registered destinations.
   */
  async listDestinations(
    ctx: RunQueryCtx,
    options?: { activeOnly?: boolean }
  ): Promise<DestinationListItem[]> {
    return await ctx.runQuery(this.component.public.listDestinations, {
      activeOnly: options?.activeOnly,
    });
  }

  /**
   * Get the HMAC signing secret for a destination.
   */
  async getSigningSecret(
    ctx: RunQueryCtx,
    destinationId: string
  ): Promise<string | null> {
    return await ctx.runQuery(this.component.public.getSigningSecret, {
      destinationId,
    });
  }

  /**
   * Get the status of a specific webhook delivery.
   */
  async getWebhookStatus(
    ctx: RunQueryCtx,
    webhookId: string
  ): Promise<WebhookStatus | null> {
    return await ctx.runQuery(this.component.public.getWebhookStatus, {
      webhookId,
    });
  }

  /**
   * Get delivery history for a destination.
   */
  async getDeliveryHistory(
    ctx: RunQueryCtx,
    destinationId: string,
    options?: { limit?: number }
  ): Promise<DeliveryAttempt[]> {
    return await ctx.runQuery(this.component.public.getDeliveryHistory, {
      destinationId,
      limit: options?.limit,
    });
  }

  /**
   * Get all failed webhooks for a destination.
   */
  async getFailedWebhooks(
    ctx: RunQueryCtx,
    destinationId: string,
    options?: { limit?: number }
  ): Promise<FailedWebhook[]> {
    return await ctx.runQuery(this.component.public.getFailedWebhooks, {
      destinationId,
      limit: options?.limit,
    });
  }
}

// ─── Utility: Verify webhook signature (for recipients) ─────────

/**
 * Verify a webhook signature on the receiving end.
 * Use this in your webhook handler to validate incoming webhooks.
 *
 * @param body - The raw request body string
 * @param headers - Object with webhook-id, webhook-timestamp, webhook-signature headers
 * @param secret - The signing secret (with or without whsec_ prefix)
 * @param tolerance - Max age in seconds (default 300 = 5 minutes)
 */
export async function verifyWebhookSignature(
  body: string,
  headers: {
    "webhook-id": string;
    "webhook-timestamp": string;
    "webhook-signature": string;
  },
  secret: string,
  tolerance: number = 300
): Promise<boolean> {
  const msgId = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signatures = headers["webhook-signature"];

  if (!msgId || !timestamp || !signatures) return false;

  // Check timestamp tolerance
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > tolerance) return false;

  // Compute expected signature
  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const toSign = `${msgId}.${timestamp}.${body}`;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(rawSecret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(toSign)
  );
  const bytes = new Uint8Array(signatureBytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const expected = `v1,${btoa(binary)}`;

  // Compare all provided signatures
  for (const sig of signatures.split(" ")) {
    if (sig === expected) return true;
  }
  return false;
}

// ─── Type Helpers ───────────────────────────────────────────────

type UseApi<API> = {
  [mod in keyof API]: API[mod] extends FunctionReference<any, any, any, any>
    ? API[mod]
    : UseApi<API[mod]>;
};
