'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EXPLORER_URL, NETWORK_PASSPHRASE } from '@/lib/config';
import { checkTrustline, ensureTrustline } from '@/lib/trustline';
import { assertAnchorWallet, signTransactionXdr } from '@/lib/wallet';
import {
  HOME_DOMAIN,
  sessionValid,
  tokenSession,
  validateChallenge,
  tryAmount,
  terminal,
  type AnchorDiagnostic,
  type Discovery,
  type Session,
} from '@/lib/anchor/sep';

type Prepared = { mock_bank: boolean; min_usdc?: string; max_usdc?: string };
type LockedQuote = {
  id: string;
  source_amount: string;
  destination_amount: string;
  rate: string;
  fee: { total: string; asset: string };
  expires_at: string;
};
export type AnchorPayment = {
  id: string;
  status: string;
  verification?: string;
  settlement: string | null;
  spendable?: boolean;
  /** Unpaid deposit whose firm quote expired: it can no longer be paid, so start over. */
  stale?: boolean;
  destination_address: string;
  amount_try: string;
  amount_usdc: string;
  stellar_tx_hash: string | null;
  usdc_after?: string;
  instructions?: Record<string, { value: string }> | null;
};
type RecoveryContext = Pick<
  AnchorPayment,
  'id' | 'amount_try' | 'amount_usdc' | 'instructions'
> & { quote_id: string };
function savedContext(raw: string | null, id: string): RecoveryContext | null {
  try {
    const value = JSON.parse(raw ?? 'null') as RecoveryContext | null;
    if (
      !value ||
      value.id !== id ||
      typeof value.quote_id !== 'string' ||
      typeof value.amount_try !== 'string' ||
      typeof value.amount_usdc !== 'string' ||
      !value.instructions ||
      !['bank_name', 'bank_account_number', 'external_transfer_memo'].every(
        (key) => typeof value.instructions?.[key]?.value === 'string',
      )
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
function isDelivered(payment: AnchorPayment, wallet: string) {
  return (
    payment.status === 'completed' &&
    payment.settlement === 'payment' &&
    payment.verification === 'verified' &&
    payment.spendable === true &&
    payment.destination_address === wallet
  );
}
class AnchorRequestError extends Error {
  readonly diagnostic?: AnchorDiagnostic;
  constructor(message: string, diagnostic?: AnchorDiagnostic) {
    super(message);
    this.diagnostic = diagnostic;
  }
}
async function request<T>(
  path: string,
  payload?: object,
  token?: string,
): Promise<T> {
  const response = await fetch(path, {
    method: payload ? 'POST' : 'GET',
    cache: 'no-store',
    headers: {
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  const data = (await response.json()) as T & {
    error?: { code?: string; diagnostic?: AnchorDiagnostic };
  };
  if (!response.ok)
    throw new AnchorRequestError(
      data.error?.code || 'Anchor request failed.',
      data.error?.diagnostic,
    );
  return data as T;
}
export function AnchorOnrampCard({
  wallet,
  onVerified,
  onContinue,
}: {
  wallet: string;
  onVerified: (payment: AnchorPayment) => void;
  onContinue: () => void;
}) {
  const [amount, setAmount] = useState('50');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [quote, setQuote] = useState<LockedQuote | null>(null);
  const [order, setOrder] = useState<AnchorPayment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stopped, setStopped] = useState(false);
  const [notice, setNotice] = useState('');
  const [diagnostic, setDiagnostic] = useState<AnchorDiagnostic | null>(null);
  const [needsTrustline, setNeedsTrustline] = useState(false);
  const [now, setNow] = useState(0);
  const [recoveryId, setRecoveryId] = useState('');
  const [simulated, setSimulated] = useState(false);
  const [history, setHistory] = useState<{ id: string; status: string }[]>([]);
  const session = useRef<Session | null>(null);
  const locked = useRef(false);
  const generation = useRef(0);
  const delivered = useRef(false);
  const callback = useRef(onVerified);
  const journal = `rise:anchor:${HOME_DOMAIN}:${NETWORK_PASSPHRASE}:${wallet}`;
  useEffect(() => {
    callback.current = onVerified;
  }, [onVerified]);
  useEffect(() => {
    const currentGeneration = ++generation.current;
    session.current = null;
    delivered.current = false;
    // The parent keys this card by wallet; state starts fresh on account changes.
    // Recover browser-only public IDs after hydration. JWTs never persist.
    queueMicrotask(() => {
      if (generation.current !== currentGeneration) return;
      const saved = localStorage.getItem(journal);
      if (!saved) return;
      setRecoveryId(saved !== 'unknown' ? saved : '');
      setStopped(true);
    });
    return () => {
      generation.current = currentGeneration + 1;
      session.current = null;
    };
  }, [wallet, journal]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = !!quote && now >= Date.parse(quote.expires_at);
  let validAmount = false;
  try {
    tryAmount(amount);
    validAmount = true;
  } catch {}
  const activeToken = useCallback(async () => {
    try {
      await assertAnchorWallet(wallet);
    } catch {
      session.current = null;
      setPrepared(null);
      setQuote(null);
      throw new Error(
        'Wallet or network changed. Authorize again on Stellar Testnet.',
      );
    }
    if (
      !sessionValid(session.current, wallet, NETWORK_PASSPHRASE, HOME_DOMAIN)
    ) {
      session.current = null;
      setPrepared(null);
      setQuote(null);
      throw new Error('Session expired. Authorize again with your wallet.');
    }
    return session.current!.token;
  }, [wallet]);
  async function loadExisting(id: string, token: string, g: number) {
    localStorage.setItem(journal, id);
    setRecoveryId(id);
    setStopped(true);
    const payment = await request<AnchorPayment>(
      `/api/anchor/onramp?${new URLSearchParams({ wallet, id })}`,
      undefined,
      token,
    );
    if (g !== generation.current) return;
    const context = savedContext(
      localStorage.getItem(journal + ':context'),
      id,
    );
    if (order?.id !== payment.id) delivered.current = false;
    setOrder({
      ...payment,
      instructions:
        payment.instructions ??
        context?.instructions ??
        (order?.id === payment.id ? order.instructions : null),
      amount_usdc:
        payment.status !== 'completed' && payment.amount_usdc === '0.0000000'
          ? (context?.amount_usdc ?? payment.amount_usdc)
          : payment.amount_usdc,
    });
    if (isDelivered(payment, wallet)) {
      localStorage.removeItem(journal);
      localStorage.removeItem(journal + ':context');
      if (!delivered.current) callback.current(payment);
      delivered.current = true;
    }
    setSimulated(payment.status !== 'pending_user_transfer_start');
    setStopped(false);
    setNotice('');
  }
  async function resolveRecovery(token: string, g: number, browse = false) {
    const saved = localStorage.getItem(journal);
    if (saved && saved !== 'unknown' && !browse) {
      await loadExisting(saved, token, g);
      return;
    }
    let result: { transactions: { id: string; status: string }[] };
    try {
      result = await request(
        '/api/anchor/demo',
        { action: 'history', wallet },
        token,
      );
    } catch (cause) {
      throw new Error(
        'Anchor transaction history is unreachable right now. Try again before creating a new deposit.',
        { cause },
      );
    }
    if (g !== generation.current) return;
    setHistory(result.transactions);
    const knownId = order?.id || (saved && saved !== 'unknown' ? saved : '');
    const existing =
      result.transactions.find((t) => t.id === knownId) ??
      result.transactions.find((t) => !terminal(t.status));
    if (existing || knownId) {
      await loadExisting(existing?.id || knownId, token, g);
      return;
    }
    // Complete, authenticated, correctly scoped history has no unresolved deposit.
    // Historical terminal transactions must not replace the new-deposit form.
    if (saved === 'unknown') {
      localStorage.removeItem(journal);
      localStorage.removeItem(journal + ':context');
    }
    setRecoveryId('');
    setStopped(false);
    setError('');
    setNotice('');
    if (quote && Date.now() >= Date.parse(quote.expires_at)) setQuote(null);
  }
  async function run(
    action:
      | 'auth'
      | 'quote'
      | 'deposit'
      | 'simulate'
      | 'trustline'
      | 'recover'
      | 'history',
  ) {
    if (locked.current || !wallet) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setDiagnostic(null);
    const g = generation.current;
    let mutation = false;
    try {
      await assertAnchorWallet(wallet);
      if (g !== generation.current) return;
      if (action === 'auth') {
        const challenge = await request<{
          transaction: string;
          discovery: Discovery;
        }>('/api/anchor/demo', { action: 'challenge', wallet });
        if (g !== generation.current) return;
        validateChallenge(challenge.transaction, challenge.discovery, wallet);
        let signed: string;
        try {
          signed = await signTransactionXdr(challenge.transaction, wallet);
        } catch {
          throw new Error(
            'The wallet signature was rejected or not completed. Press the authorize button to try again.',
          );
        }
        await assertAnchorWallet(wallet);
        if (g !== generation.current) return;
        const original = validateChallenge(
          challenge.transaction,
          challenge.discovery,
          wallet,
        );
        const signedTx = validateChallenge(signed, challenge.discovery, wallet);
        if (
          !original
            .hash()
            .every((byte, index) => byte === signedTx.hash()[index])
        )
          throw new Error('The wallet altered the authorization transaction.');
        const auth = await request<{ token: string; discovery: Discovery }>(
          '/api/anchor/demo',
          { action: 'auth', wallet, transaction: signed },
        );
        if (g !== generation.current) return;
        session.current = tokenSession(auth.token, wallet, auth.discovery);
        const ready = await request<Prepared>(
          '/api/anchor/demo',
          { action: 'prepare', wallet },
          await activeToken(),
        );
        const trust = await checkTrustline(wallet, 'USD');
        if (g === generation.current) {
          setPrepared(ready);
          setNeedsTrustline(trust.state !== 'present');
          if (localStorage.getItem(journal))
            await resolveRecovery(await activeToken(), g);
        }
        return;
      }
      if (action === 'trustline') {
        await ensureTrustline(wallet, 'USD');
        if (g === generation.current) setNeedsTrustline(false);
        return;
      }
      const token = await activeToken();
      if (g !== generation.current) return;
      if (action === 'history') {
        await resolveRecovery(token, g, true);
      } else if (action === 'quote') {
        if (stopped || order) return;
        const result = await request<LockedQuote>(
          '/api/anchor/demo',
          { action: 'quote', wallet, amount_try: tryAmount(amount) },
          token,
        );
        if (g === generation.current) {
          setQuote(result);
          setNow(Date.now());
        }
      } else if (action === 'deposit') {
        if (stopped || order || !quote) return;
        if (Date.now() >= Date.parse(quote.expires_at)) {
          setNow(Date.now());
          return;
        }
        localStorage.removeItem(journal + ':context');
        localStorage.setItem(journal, 'unknown');
        mutation = true;
        const result = await request<AnchorPayment>(
          '/api/anchor/onramp',
          { wallet, quote_id: quote.id, amount_try: quote.source_amount },
          token,
        );
        // Preserve only public bank instructions and the locked quote context.
        // Storage never establishes delivery or authorizes a payment.
        localStorage.setItem(
          journal + ':context',
          JSON.stringify({
            id: result.id,
            quote_id: quote.id,
            amount_try: result.amount_try,
            amount_usdc: result.amount_usdc,
            instructions: result.instructions,
          } satisfies RecoveryContext),
        );
        localStorage.setItem(journal, result.id);
        if (g === generation.current) {
          setOrder(result);
          setRecoveryId(result.id);
        }
      } else if (action === 'simulate') {
        if (!order || simulated || !prepared?.mock_bank) return;
        setSimulated(true);
        mutation = true;
        await request(
          '/api/anchor/demo',
          { action: 'simulate', wallet, id: order.id },
          token,
        );
      } else {
        await loadExisting(recoveryId, token, g);
      }
    } catch (cause) {
      if (g !== generation.current) return;
      const failure =
        cause instanceof Error && cause.cause instanceof AnchorRequestError
          ? cause.cause
          : cause;
      setDiagnostic(
        failure instanceof AnchorRequestError
          ? (failure.diagnostic ?? null)
          : null,
      );
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not reach the Anchor.',
      );
      if (mutation) setStopped(true);
    } finally {
      locked.current = false;
      if (g === generation.current) setBusy(false);
    }
  }
  const orderId = order?.id;
  useEffect(() => {
    if (!orderId || stopped || delivered.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 180000;
    async function poll() {
      try {
        const token = await activeToken();
        if (cancelled) return;
        const result = await request<AnchorPayment>(
          `/api/anchor/onramp?${new URLSearchParams({ wallet, id: orderId! })}`,
          undefined,
          token,
        );
        await assertAnchorWallet(wallet);
        if (cancelled) return;
        setError('');
        setOrder((previous) => ({
          ...result,
          amount_usdc:
            result.amount_usdc === '0.0000000' && result.status !== 'completed'
              ? (previous?.amount_usdc ?? result.amount_usdc)
              : result.amount_usdc,
          instructions: result.instructions ?? previous?.instructions,
        }));
        if (isDelivered(result, wallet)) {
          delivered.current = true;
          localStorage.removeItem(journal);
          localStorage.removeItem(journal + ':context');
          callback.current(result);
          return;
        }
        if (result.stale) return;
        if (terminal(result.status)) {
          const message =
            result.status === 'completed'
              ? 'Transaction completed, but spendable USDC delivery was not verified.'
              : 'Anchor transaction ended: ' + result.status;
          if (result.status === 'error') setError(message);
          else setNotice(message);
          return;
        }
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof Error ? cause.message : 'Could not read the transaction status.',
        );
        if (!session.current) {
          setStopped(true);
          return;
        }
      }
      if (Date.now() >= deadline) {
        setStopped(true);
        setNotice(
          'Tracking timed out; this does not mean the payment failed. Check the same transaction ID again.',
        );
        return;
      }
      if (!cancelled) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Keep the deadline tied to this immutable transaction, not each status update.
  }, [orderId, stopped, wallet, journal, activeToken]);
  const verified = !!order && isDelivered(order, wallet);
  const recovering = !order && stopped;
  const enteringAmount = !order && !recovering;
  const reviewingQuote = enteringAmount && !!quote;
  const remainingSeconds = quote
    ? Math.max(0, Math.ceil((Date.parse(quote.expires_at) - now) / 1000))
    : 0;
  const priceTime = `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`;
  const statusLabel = verified
    ? 'Completed'
    : order?.settlement === 'claimable_balance'
      ? 'USDC waiting to be claimed'
      : (
          {
            incomplete: 'Deposit details are incomplete',
            pending_user:
              'The Anchor is waiting for a user step; check the transaction details',
            pending_user_transfer_start: 'Waiting for bank transfer',
            pending_user_transfer_complete: 'Bank transfer being checked',
            pending_anchor: 'Anchor is processing',
            pending_stellar: 'Sending USDC to your wallet',
            pending_trust: 'USDC trustline bekleniyor',
            completed: 'Waiting for delivery verification',
            error: 'Deposit could not be completed',
            expired: 'Deposit expired',
            refunded: 'Deposit refunded',
          } as Record<string, string>
        )[order?.status || ''] || 'Checking transaction status';
  const instruction = (key: string) => order?.instructions?.[key]?.value || '—';
  return (
    <Card className="anchor-step gap-0 rounded-none border-0 border-b border-[#e3eae4] bg-white py-0 shadow-none ring-0">
      <CardHeader className="px-5 pb-3 pt-6 sm:px-8">
        <CardTitle className="flex items-center gap-3 text-lg tracking-tight">
          Add funds to your wallet
          <span className="ml-auto text-xs font-normal text-[#60756b]">
            Anchor
          </span>
        </CardTitle>
        <CardDescription>
          Stellar Testnet · Bank and KYC are simulated. Never send real money.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-6 text-sm sm:px-8">
        <p className="text-xs text-[#64786e]">
          TRY is deposited as USDC first. Then continue in Send with a separate
          wallet signature.
        </p>
        {!wallet && <p>Connect your Stellar wallet to start.</p>}
        {recovering && (
          <div className="space-y-3 rounded-xl border border-[#dce5df] bg-[#fafbf8] p-4">
            <p className="font-medium">Let&apos;s check your previous deposit</p>
            <p>Continue with your wallet to verify the last attempt.</p>
            {prepared && (
              <Button disabled={busy} onClick={() => run('history')}>
                Retry check
              </Button>
            )}
          </div>
        )}
        {!prepared && !enteringAmount && (
          <Button disabled={busy || !wallet} onClick={() => run('auth')}>
            Continue with wallet
          </Button>
        )}
        {prepared && (
          <p className="text-xs text-[#64786e]">
            Wallet authorized · Simulated KYC approved
          </p>
        )}
        {needsTrustline && (
          <Button disabled={busy} onClick={() => run('trustline')}>
            USDC trustline ekle
          </Button>
        )}
        {enteringAmount && (
          <>
            <label
              htmlFor="anchor-try-amount"
              className="block space-y-2 text-xs text-[#64786e]"
            >
              How much do you want to deposit?
              <Input
                id="anchor-try-amount"
                aria-label="TRY amount"
                className="h-14 rounded-xl bg-[#f6f8f4] text-2xl"
                inputMode="decimal"
                value={amount}
                disabled={busy}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setQuote(null);
                }}
              />
            </label>
            <p className="text-xs text-[#64786e]">50–3000 TRY</p>
            {!prepared ? (
              <Button
                disabled={busy || !wallet || !validAmount}
                onClick={() => run('auth')}
              >
                Continue with wallet
              </Button>
            ) : (
              !quote && (
                <Button
                  variant="outline"
                  disabled={busy || needsTrustline || !validAmount}
                  onClick={() => run('quote')}
                >
                  Show price
                </Button>
              )
            )}
          </>
        )}
        {reviewingQuote && quote && (
          <div className="space-y-2 rounded-xl border border-[#dce5df] bg-[#fafbf8] p-4">
            <p className="font-medium">Review</p>
            <p>
              {quote.source_amount} TRY → {quote.destination_amount} USDC
            </p>
            <p>Rate: {quote.rate} TRY / USDC</p>
            <p>
              Anchor fee: {quote.fee.total}{' '}
              {quote.fee.asset.replace('iso4217:', '')} (separate from the Veldora fee)
            </p>
            <p className="text-xs" aria-live="polite">
              {expired
                ? 'The price expired.'
                : `Price valid for ${priceTime}`}
            </p>
            <details className="text-xs">
              <summary>Price details</summary>Valid until:{' '}
              {quote.expires_at}
            </details>
            {expired ? (
              <Button
                disabled={busy || !prepared || needsTrustline || !validAmount}
                onClick={() => run('quote')}
              >
                Refresh price
              </Button>
            ) : (
              <Button
                disabled={busy || !prepared || stopped || needsTrustline}
                onClick={() => run('deposit')}
              >
                Continue to deposit
              </Button>
            )}
          </div>
        )}
        {order && (
          <div
            aria-live="polite"
            className="space-y-2 rounded-xl border border-[#cde2ce] bg-[#f0f7e9] p-4"
          >
            <p className="font-medium">
              {verified
                ? 'USDC arrived in your wallet'
                : order.status === 'pending_user_transfer_start'
                  ? 'Your deposit instructions are ready'
                  : 'Deposit status'}
            </p>
            <p>
              {order.amount_try} TRY → {order.amount_usdc} USDC
            </p>
            <p>{statusLabel}</p>
            <p className="break-all text-xs">
              Anchor transaction ID: {order.id}
            </p>
            <p>{instruction('bank_name')}</p>
            <p className="break-all">
              IBAN: {instruction('bank_account_number')}
            </p>
            <p>Reference: {instruction('external_transfer_memo')}</p>
            {order.stale && (
              <p>
                This deposit&apos;s locked quote expired before the bank
                transfer. No money moved; start a new deposit.
              </p>
            )}
            {order.status === 'pending_user_transfer_start' && !order.stale && (
              <Button
                disabled={busy || simulated || stopped || !prepared?.mock_bank}
                onClick={() => run('simulate')}
              >
                Simulate test bank transfer
              </Button>
            )}
            {order.status === 'pending_trust' && (
              <p>Waiting for a USDC trustline; no spendable balance yet.</p>
            )}
            {order.settlement === 'claimable_balance' && (
              <p>USDC is in a claimable balance; not spendable yet.</p>
            )}
            {verified && (
              <p>
                USDC delivery verified on-chain. Balance: {order.usdc_after}
              </p>
            )}
            {order.stellar_tx_hash && (
              <a
                className="block break-all text-xs underline"
                href={`${EXPLORER_URL}/tx/${order.stellar_tx_hash}`}
                target="_blank"
                rel="noreferrer"
              >
                Stellar transaction hash: {order.stellar_tx_hash}
              </a>
            )}
          </div>
        )}
        {order && stopped && prepared && (
          <Button disabled={busy} onClick={() => run('recover')}>
            Retry tracking
          </Button>
        )}
        {notice && <output className="block text-[#64786e]">{notice}</output>}
        {busy && <output>Anchor request in progress…</output>}
        {error && (
          <p role="alert" className="text-red-800">
            {error}
          </p>
        )}
        {verified && !stopped && (
          <Button
            className="w-full"
            onClick={async () => {
              try {
                await activeToken();
                onContinue();
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : 'Authorize your wallet again.',
                );
              }
            }}
          >
            Continue to Send
          </Button>
        )}
        {order &&
          (terminal(order.status) || order.stale) &&
          (verified || order.status !== 'completed') && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                localStorage.removeItem(journal);
                localStorage.removeItem(journal + ':context');
                setOrder(null);
                setQuote(null);
                setStopped(false);
                setRecoveryId('');
                setSimulated(false);
                setError('');
                setNotice('');
                delivered.current = false;
              }}
            >
              New deposit
            </Button>
          )}
        <details className="border-t pt-3 text-xs">
          <summary>Troubleshooting</summary>
          {order && <p>Anchor status: {order.status}</p>}
          {process.env.NODE_ENV === 'development' && diagnostic && (
            <div className="my-3 space-y-1 break-all">
              <p>Development diagnostics</p>
              <p>
                {diagnostic.method} {diagnostic.endpoint}
              </p>
              <p>Anchor HTTP: {diagnostic.status}</p>
              <p>Anchor reason: {diagnostic.reason}</p>
            </div>
          )}
          <Button
            variant="outline"
            disabled={busy || !prepared}
            onClick={() => run('history')}
          >
            Find recent deposits
          </Button>
          {history.map((t) => (
            <button
              key={t.id}
              className="my-2 block break-all underline"
              onClick={() => setRecoveryId(t.id)}
            >
              {t.id} · {t.status}
            </button>
          ))}
          <Input
            aria-label="Anchor transaction ID"
            value={recoveryId}
            onChange={(e) => setRecoveryId(e.target.value)}
            className="my-2"
          />
          <Button
            variant="outline"
            disabled={busy || !prepared || !recoveryId}
            onClick={() => run('recover')}
          >
            Look up by transaction ID
          </Button>
        </details>
      </CardContent>
    </Card>
  );
}
