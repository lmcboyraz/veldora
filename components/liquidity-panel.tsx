'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ASSETS, EXPLORER_URL, FX_ROUTER, type AssetKey } from '@/lib/config';
import { formatAmount, shorten, unresolvedMessage } from '@/lib/stellar';
import { checkLpRecord, configureProvider, getLiquidityState, moveLiquidity, registerProvider } from '@/lib/liquidity';
import { readLpRecord } from '@/lib/lp-transaction';
import { parseLiquidityAmount, parsePairInput } from '@/lib/liquidity-input';

type State = Awaited<ReturnType<typeof getLiquidityState>>;
const editableAmount = (value: bigint) => formatAmount(value, 7).replaceAll(',', '');

export function LiquidityPanel({ wallet, connect, visible, onConfirmed }: {
  wallet: string; connect: () => void; visible: boolean;
  onConfirmed: (wallet: string, ledger: number) => Promise<void>;
}) {
  const [target, setTarget] = useState<AssetKey>('EUR');
  const [source, setSource] = useState<AssetKey>('USD');
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fee, setFee] = useState('20');
  const [maxTrade, setMaxTrade] = useState('3');
  const [cap, setCap] = useState('10');
  const [active, setActive] = useState(true);
  const [asset, setAsset] = useState<AssetKey>('EUR');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [hash, setHash] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [checking, setChecking] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  // The parent keys this panel by network/router/wallet; hiding a tab does not reset this floor.
  const minimumLedger = useRef(0);
  const pendingParentLedger = useRef(0);
  const confirmedCallback = useRef(onConfirmed);
  confirmedCallback.current = onConfirmed;
  const generation = useRef(0);
  const locked = useRef(false);
  const alive = useRef(true);
  const invalidate = useCallback(() => { ++generation.current; }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; invalidate(); }; }, [invalidate]);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!wallet) return;
    setLoading(true); setState(null); setRefreshError('');
    try {
      const parentLedger = pendingParentLedger.current;
      const [reading, parent] = await Promise.allSettled([
        getLiquidityState(wallet, source, target, minimumLedger.current),
        parentLedger ? Promise.resolve().then(() => confirmedCallback.current(wallet, parentLedger)) : Promise.resolve(),
      ]);
      if (!alive.current || request !== generation.current) return;
      if (parent.status === 'rejected') setRefreshError('Transaction confirmed. Wallet or provider balances could not refresh; reconnect or refresh to try again.');
      else if (pendingParentLedger.current === parentLedger) pendingParentLedger.current = 0;
      if (reading.status === 'rejected') throw reading.reason;
      const next = reading.value;
      setState(next);
      setFee(String(next.pair?.fee_bps ?? 20));
      setMaxTrade(editableAmount(next.pair?.max_amount_in ?? 30000000n));
      setCap(editableAmount(next.pair?.max_source_inventory ?? 100000000n));
      setActive(next.pair?.active ?? true);
    } catch { if (alive.current && request === generation.current) setRefreshError('Liquidity could not be loaded. Refresh to try again.'); }
    finally { if (alive.current && request === generation.current) setLoading(false); }
  }, [wallet, source, target]);
  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => { window.clearTimeout(timer); invalidate(); };
  }, [visible, refresh, invalidate]);

  const refreshConfirmed = useCallback(async (ledger: number, movement: boolean) => {
    minimumLedger.current = Math.max(minimumLedger.current, ledger);
    if (movement) pendingParentLedger.current = Math.max(pendingParentLedger.current, ledger);
    // Failed parent reads remain retryable through Refresh; the settled transaction is never retried.
    await refresh();
  }, [refresh]);

  /** Reads this wallet's saved LP hash and settles it from the network; an unresolved one keeps the lock. */
  const check = useCallback(async () => {
    if (!wallet || locked.current) return;
    locked.current = true; setChecking(true);
    try {
      const saved = readLpRecord(wallet);
      if (!saved) { setUncertain(false); return; }
      setUncertain(true); setHash(saved.hash); setMessage('Checking the saved liquidity transaction on Stellar…');
      const found = await checkLpRecord(wallet);
      if (!alive.current || !found) return;
      if (found.state === 'pending') { setMessage(unresolvedMessage(found.saved, 'liquidity transaction', found.networkTime)); return; }
      setUncertain(false);
      setMessage(found.state === 'success' ? 'The earlier liquidity transaction is confirmed on Stellar Testnet.'
        : found.state === 'failed' ? 'The earlier liquidity transaction failed on Stellar Testnet. Nothing moved.'
        : 'The earlier liquidity transaction expired without executing. Nothing moved.');
      if (found.state === 'success' && found.saved.router === FX_ROUTER && found.saved.network === 'testnet') {
        await refreshConfirmed(found.ledger!, found.saved.kind === 'deposit' || found.saved.kind === 'withdraw');
      } else await refresh();
    } catch (error) {
      if (!alive.current) return;
      setUncertain(true);
      setMessage(error instanceof Error && error.message.length <= 220 ? error.message : 'Could not check the saved liquidity transaction. Try again.');
    } finally { locked.current = false; if (alive.current) setChecking(false); }
  }, [wallet, refresh, refreshConfirmed]);
  // A reopened page restores the saved hash and its duplicate-send lock before anything can be signed.
  useEffect(() => { const timer = window.setTimeout(() => void check(), 0); return () => window.clearTimeout(timer); }, [check]);

  async function run(kind: 'register' | 'pair' | 'deposit' | 'withdraw') {
    if (!wallet || !state || locked.current || uncertain) return;
    locked.current = true; setBusy(true); setMessage(''); setHash('');
    try {
      const moved = asset;
      let inventory: bigint | null = null;
      const result = kind === 'register' ? await registerProvider(wallet)
        : kind === 'pair' ? await configureProvider(wallet, source, target, parsePairInput(fee, maxTrade, cap, active))
        : await moveLiquidity(wallet, moved, parseLiquidityAmount(amount), kind).then(settled => { inventory = settled.inventory; return settled; });
      if (!alive.current) return;
      setHash(result.hash); setMessage(inventory === null ? 'Transaction confirmed on Stellar Testnet.' : `Transaction confirmed on Stellar Testnet. ${ASSETS[moved].code} router inventory at confirmation: ${formatAmount(inventory, 7)}.`);
      await refreshConfirmed(result.result.ledger, kind === 'deposit' || kind === 'withdraw');
    } catch (error) {
      if (!alive.current) return;
      const text = error instanceof Error ? error.message : 'Transaction could not be completed.';
      setMessage(text.length > 220 ? 'Transaction could not be completed. Check your balance and asset trustline.' : text);
      // The hash was saved before submission; while it is unresolved nothing else may be signed.
      let saved = null;
      try { saved = readLpRecord(wallet); } catch { setUncertain(true); }
      if (saved) { setUncertain(true); setHash(saved.hash); setMessage(unresolvedMessage(saved, 'liquidity transaction')); }
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  const disabled = busy || loading || !state || uncertain;
  return <div className="liquidity-panel">
    <div className="panel-heading"><div><p className="eyebrow">YOUR LIQUIDITY</p><h1>Put your assets to work.</h1><p>Set your terms. Earn a fee when your route is selected.</p></div>
      {wallet && <Button variant="outline" onClick={() => void refresh()} disabled={busy || loading}>Refresh</Button>}
    </div>
    {!wallet ? <div className="empty-state"><span className="empty-symbol">↗</span><h2>Your wallet, your liquidity.</h2><p>Connect to view your LP status, inventory and earned fees.</p><Button onClick={connect}>Connect wallet</Button></div> : <>
      <div className="lp-status"><span>{loading ? 'Checking LP status…' : !state ? 'Status unavailable' : state.registered ? '● Registered liquidity provider' : 'Not registered as an LP'}</span><span className="font-mono text-xs">{shorten(wallet, 8)}</span></div>
      {state?.paused && <p className="inline-notice">The active router is paused. Swaps are unavailable; existing LPs can still manage their inventory.</p>}
      {state && !state.registered && <div className="registration-row"><div><h2>Become a liquidity provider</h2><p>{state.permissionless ? 'Register with your wallet signature, then configure your pair and deposit.' : 'Self-registration is unavailable on the active router. The permissionless deployment has not been activated yet.'}</p></div><Button disabled={disabled || !state.permissionless} onClick={() => void run('register')}>Become LP</Button></div>}
      <div className="inventory-grid">{(Object.keys(ASSETS) as AssetKey[]).map(key => <div className="inventory-tile" key={key}><p>{ASSETS[key].code} router inventory</p><strong>{state ? formatAmount(state.stats[key].balance, 7) : '—'}</strong><span>Earned fees · {state ? formatAmount(state.stats[key].fees, 7) : '—'} {ASSETS[key].code}</span></div>)}</div>
      {state?.registered && <div className="lp-controls">
        <fieldset disabled={disabled || !state?.registered} className="lp-form"><legend>Routing terms</legend>
          <label>Source<select value={source} onChange={e => { invalidate(); setSource(e.target.value as AssetKey); }}>{(Object.keys(ASSETS) as AssetKey[]).map(key=><option key={key} value={key}>{ASSETS[key].code}</option>)}</select></label>
          <label>Target<select value={target} onChange={e => { invalidate(); setTarget(e.target.value as AssetKey); }}>{(Object.keys(ASSETS) as AssetKey[]).map(key=><option key={key} value={key}>{ASSETS[key].code}</option>)}</select></label>
          {source===target && <p role="alert">Choose different currencies for the LP pair.</p>}
          <div className="grid grid-cols-2 gap-3"><label htmlFor="lp-fee">Fee · bps<Input id="lp-fee" inputMode="numeric" value={fee} onChange={e => setFee(e.target.value)} /></label><label htmlFor="lp-max">Max trade · {ASSETS[source].code}<Input id="lp-max" inputMode="decimal" value={maxTrade} onChange={e => setMaxTrade(e.target.value)} /></label></div>
          <label htmlFor="lp-cap">Source inventory cap · {ASSETS[source].code}<Input id="lp-cap" inputMode="decimal" value={cap} onChange={e => setCap(e.target.value)} /></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> Pair active</label>
          <Button disabled={source===target} onClick={() => void run('pair')}>Save pair configuration</Button>
        </fieldset>
        <fieldset disabled={disabled || !state?.registered} className="lp-form"><legend>Manage inventory</legend>
          <label>Asset<select value={asset} onChange={e => setAsset(e.target.value as AssetKey)}>{(Object.keys(ASSETS) as AssetKey[]).map(key=><option key={key} value={key}>{ASSETS[key].code}</option>)}</select></label>
          <label htmlFor="lp-amount">Amount<Input id="lp-amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} /></label>
          <p className="text-xs text-[#53685c]">Available in wallet · {!state.wallet ? 'unavailable' : state.wallet[asset] === null ? `no ${ASSETS[asset].code} trustline` : `${formatAmount(state.wallet[asset], 7)} ${ASSETS[asset].code}`}<br />Router inventory · {formatAmount(state.stats[asset].balance, 7)} {ASSETS[asset].code}</p>
          <p className="text-xs text-[#64786e]">Deposits move tokens from your wallet into this router. Withdrawals return them to your wallet. A matching asset trustline is required. rTRY and rGBP are testnet demo tokens; TRY is priced by a demo/mock feed, not Reflector. Network fees are paid separately in XLM.</p>
          <div className="flex gap-2"><Button onClick={() => void run('deposit')}>Deposit</Button><Button variant="outline" onClick={() => void run('withdraw')}>Withdraw</Button></div>
        </fieldset>
      </div>}
    </>}
    {(busy || message) && <output className="inline-notice block">{busy ? 'Confirm in your wallet. Waiting for Stellar…' : message}</output>}
    {refreshError && <output className="inline-notice block">{refreshError}</output>}
    {hash && <a className="tx-link" href={`${EXPLORER_URL}/tx/${hash}`} target="_blank" rel="noreferrer">Liquidity transaction ↗ {shorten(hash, 8)}</a>}
    {uncertain && <><Button variant="outline" onClick={() => void check()} disabled={checking || busy}>Check transaction</Button>
      <a className="tx-link" href={`${EXPLORER_URL}/account/${wallet}`} target="_blank" rel="noreferrer">Check wallet activity ↗</a></>}
    <details className="technical-details"><summary>Router &amp; fee details</summary><p>Fees are accounted for within LP inventory, not a separate balance to claim. Each direction has its own terms. A zero max trade or inventory cap means unlimited.</p><a href={`${EXPLORER_URL}/contract/${FX_ROUTER}`} target="_blank" rel="noreferrer">Active router · {FX_ROUTER}</a></details>
  </div>;
}
