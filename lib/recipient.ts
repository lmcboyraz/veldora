import { StrKey } from '@stellar/stellar-sdk';

/** Send recipients are the addresses the router's `Address` argument accepts: G… accounts or C… contracts. */
export function recipientError(value: string) {
  if (!value) return 'Choose a recipient: paste a Stellar address or use your wallet.';
  if (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value)) return null;
  return 'Enter a valid Stellar account (G…) or contract (C…) address.';
}
