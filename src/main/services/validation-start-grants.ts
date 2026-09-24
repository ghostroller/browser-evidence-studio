import { randomUUID } from 'node:crypto';
import { StudioError } from '@/shared/errors';

export interface ValidationStartBinding {
  runId: string;
  projectId: string;
  profileId: string;
  workflowId: string;
  leaseEpoch: number;
  directory: string;
  workflowSha256: string;
  inputSha256: string;
  pageId: string;
  targetId: string;
  generation: number;
}

export interface ValidationStartGrant extends ValidationStartBinding {
  grantId: string;
  issuedAt: string;
  expiresAt: string;
}

const bindingKeys = [
  'runId', 'projectId', 'profileId', 'workflowId', 'leaseEpoch', 'directory',
  'workflowSha256', 'inputSha256', 'pageId', 'targetId', 'generation',
] as const satisfies readonly (keyof ValidationStartBinding)[];

const copy = (grant: ValidationStartGrant): ValidationStartGrant => JSON.parse(JSON.stringify(grant));

/** In-memory, single-use authorization. Restarting the application invalidates all grants. */
export class ValidationStartGrants {
  private record: {
    grant: ValidationStartGrant;
    deadline: number;
    status: 'available' | 'consumed' | 'revoked' | 'expired';
  } | null = null;

  constructor(private readonly nowMs = () => Date.now(), private readonly ttlMs = 120_000) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('Validation grant TTL must be finite and positive');
  }

  issue(binding: ValidationStartBinding): ValidationStartGrant {
    const issued = this.nowMs();
    // Pick the contract fields so input contents or other caller metadata are never retained.
    const selected = Object.fromEntries(bindingKeys.map(key => [key, binding[key]])) as unknown as ValidationStartBinding;
    const grant: ValidationStartGrant = {
      ...selected, grantId: randomUUID(),
      issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + this.ttlMs).toISOString(),
    };
    this.record = { grant, deadline: issued + this.ttlMs, status: 'available' };
    return copy(grant);
  }

  available(binding?: Partial<ValidationStartBinding>): ValidationStartGrant | null {
    const record = this.record;
    this.expire();
    if (!record || record.status !== 'available') return null;
    if (binding && bindingKeys.some(key => Object.hasOwn(binding, key) && binding[key] !== record.grant[key])) return null;
    return copy(record.grant);
  }

  consume(grantId: string, binding: ValidationStartBinding): ValidationStartGrant {
    const record = this.record;
    this.expire();
    if (!record || record.status === 'revoked') {
      throw new StudioError(409, 'VALIDATION_GRANT_REQUIRED', 'A current validation start authorization is required');
    }
    if (grantId !== record.grant.grantId) {
      throw new StudioError(409, 'VALIDATION_GRANT_MISMATCH', 'Validation start authorization does not match this request');
    }
    if (record.status === 'consumed') {
      throw new StudioError(409, 'VALIDATION_GRANT_CONSUMED', 'Validation start authorization has already been consumed');
    }
    if (record.status === 'expired') {
      throw new StudioError(409, 'VALIDATION_GRANT_EXPIRED', 'Validation start authorization has expired');
    }
    if (bindingKeys.some(key => binding[key] !== record.grant[key])) {
      throw new StudioError(409, 'VALIDATION_GRANT_MISMATCH', 'Validation start authorization binding has changed');
    }
    // No await or callbacks between matching and consuming: only one caller can succeed.
    record.status = 'consumed';
    return copy(record.grant);
  }

  revoke(): ValidationStartGrant | null {
    const record = this.record;
    this.expire();
    if (!record || record.status !== 'available') return null;
    record.status = 'revoked';
    return copy(record.grant);
  }

  peek(): ValidationStartGrant | null {
    return this.record ? copy(this.record.grant) : null;
  }

  private expire(): void {
    const record = this.record;
    if (record?.status === 'available' && this.nowMs() >= record.deadline) record.status = 'expired';
  }
}
