// Kept inside daemon control; never serialized as public approval or model authority.
export interface NativePauseReceipt {
  readonly sessionId: string;
  readonly requestId: string;
  readonly revision: number;
  readonly authGeneration: number;
  readonly generationId: number | null;
  readonly turnRetired: true;
  readonly callsSettled: true;
  readonly resultOwnershipConfirmed: true;
  readonly completedCalls: number;
}
