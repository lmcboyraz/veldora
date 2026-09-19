'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CurrencySelector } from '@/components/currency-selector';
import { readPayment, clearPayment, type SendPayment } from '@/lib/send-transaction';
import { amountInputError, isCurrentQuote, quoteKey } from '@/lib/fx-quote';
import { recipientError } from '@/lib/recipient';
import { LiquidityPanel } from '@/components/liquidity-panel';
import { AnchorOnrampCard, type AnchorPayment } from '@/components/anchor-onramp-card';
import {
  ArrowDownUp,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  LinkIcon,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  ASSETS,
  DEMO_AMOUNT,
  EXPLORER_URL,
  FX_ROUTER,
  PROVIDERS,
  REFLECTOR_ORACLE,
  VIEW_ACCOUNT,
  type AssetKey,
  type Quote,
  executeSwap,
  checkSendTransaction,
  formatAmount,
  getProviderStats,
  getQuote,
  getTokenBalance,
  parseAmount,
  shorten,
} from '@/lib/stellar';
import {
  type TrustlineStatus,
  checkTrustline,
  ensureTrustline,
  getWalletBalances,
} from '@/lib/trustline';
import { assertConnectedWallet, connectWallet } from '@/lib/wallet';

type ProviderStats = Awaited<ReturnType<typeof getProviderStats>>;

type SwapReceipt = {
  source: AssetKey;
  target: AssetKey;
  hash: string;
  senderBefore: bigint | null;
  senderAfter: bigint | null;
  recipientBefore: bigint | null;
  recipientAfter: bigint | null;
  quote: Quote;
  networkFee: bigint;
};

const EMPTY_BALANCES = { USD: 0n, EUR: 0n, GBP: 0n, TRY: 0n };

const savedAmount = (amount: string) => formatAmount(BigInt(amount),7);
const minutesSince = (from: number, now: number) => Math.max(0, Math.round((now - from) / 60));

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Horizon's reply when the connected account has never been funded.
  if (message === 'Not Found') return 'This wallet is not funded on Stellar Testnet yet. Fund it with Friendbot, then reconnect.';
  if (message.includes('#3')) return 'This asset is not configured on the router yet. Run the bootstrap script.';
  if (message.includes('#7') || message.includes('Insufficient')) return 'Insufficient balance for this swap.';
  if (message.includes('#8')) return 'No liquidity provider can cover this amount right now.';
  if (message.includes('trustline') || message.includes('op_no_trust')) {
    return 'The account is missing a trustline for this asset.';
  }
  if (message.includes('#10')) return 'Oracle price is stale. Swaps are temporarily blocked.';
  if (message.includes('#12')) return 'The quote expired. Refresh and try again.';
  if (message.includes('#13')) return 'Price moved beyond your minimum output.';
  return message.length > 180 ? 'The Stellar transaction could not be completed.' : message;
}

export default function Home() {
  const [tab, setTab] = useState<'send' | 'fund' | 'liquidity'>('send');
  const [walletAddress, setWalletAddress] = useState('');
  const [source, setSource] = useState<AssetKey>('USD');
  const [target, setTarget] = useState<AssetKey>('EUR');
  const [amount, setAmount] = useState(DEMO_AMOUNT);
  // Starts empty: a pre-filled address would silently send someone else's payment.
  const [recipient, setRecipient] = useState('');
  // 'wallet' = filled by "Use my wallet"; it must not outlive the account it was copied from.
  const [recipientSource, setRecipientSource] = useState<'manual' | 'wallet'>('manual');
  const [storedQuote, setQuote] = useState<Quote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [balances, setBalances] = useState(EMPTY_BALANCES);
  const [staleBalanceWallet, setStaleBalanceWallet] = useState('');
  const currentWallet = useRef(walletAddress);
  currentWallet.current = walletAddress;
  const balanceRequest = useRef(0);
  const providerRequest = useRef(0);
  // Provider floors belong to this page's fixed Testnet/router context, independently per LP.
  const providerLedgers = useRef<Record<string, number>>({});
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++balanceRequest.current; ++providerRequest.current; }; }, []);
  const [providerStats, setProviderStats] = useState<Record<string, ProviderStats>>({});
  const [action, setAction] = useState<'connect' | 'trustline' | 'swap' | null>(null);
  const [recipientTrustline, setRecipientTrustline] = useState<TrustlineStatus | null>(null);
  const [senderTrustline, setSenderTrustline] = useState<TrustlineStatus | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success' | 'pending'; text: string } | null>(null);
  const [receipt, setReceipt] = useState<SwapReceipt | null>(null);
  const [currentTimestamp, setCurrentTimestamp] = useState(0);
  const [anchorPayment, setAnchorPayment] = useState<AnchorPayment | null>(null);
  const [payment, setPayment] = useState<SendPayment | null>(null);
  const [recoveryError, setRecoveryError] = useState('');
  const [quoteError, setQuoteError] = useState('');
  const paymentRef = useRef<SendPayment | null>(null);
  const sendLock = useRef(false);
  const quoteRequest = useRef(0);
  const lastFetch = useRef<{ quote: Quote | null; at: number }>({ quote: null, at: 0 });
  function rememberPayment(next: SendPayment) { paymentRef.current = next; setPayment(next); }
  useEffect(() => {
    const timer=window.setTimeout(()=>{
      // A reopened page looks the saved hash up once (read-only); it never signs or resubmits.
      try {
        const saved=readPayment(); if(!saved) return;
        rememberPayment(saved);
        if(saved.status==='pending') void checkSendTransaction(saved,rememberPayment).then(
          ()=>setNotice({tone:'success',text:'Payment confirmed on Stellar Testnet. Start a new payment only when ready.'}),
          error=>setNotice({tone:paymentRef.current?.status==='pending'?'pending':'error',text:errorMessage(error)}));
      }
      catch(error) { setRecoveryError(errorMessage(error)); }
    },0);
    return ()=>window.clearTimeout(timer);
  }, []);

  const trustRequest = useRef({ sender: 0, recipient: 0 });
  const amountIn = useMemo(() => parseAmount(amount), [amount]);
  const requestKey = quoteKey(FX_ROUTER, walletAddress || VIEW_ACCOUNT, source, target, amountIn);
  const quote = isCurrentQuote(storedQuote, requestKey, currentTimestamp) ? storedQuote : null;
  const recipientNeedsTrustline = recipientTrustline?.state === 'missing';
  const senderNeedsTrustline = senderTrustline?.state === 'missing';
  const recipientIsWallet = Boolean(walletAddress) && recipient === walletAddress;
  const recipientProblem = recipientError(recipient);
  const amountProblem = amountInputError(amount);
  const walletBalanceUnavailable = !!walletAddress && staleBalanceWallet === walletAddress;

  const refreshBalances = useCallback(async (account: string) => {
    const request = ++balanceRequest.current;
    const next = await getWalletBalances(account);
    if (!mounted.current || currentWallet.current !== account || request !== balanceRequest.current) return;
    setBalances(next);
    setStaleBalanceWallet('');
  }, []);

  const refreshProviders = useCallback(async () => {
    const request = ++providerRequest.current;
    const entries = await Promise.all(
      PROVIDERS.map(async (provider) => [provider.address, await getProviderStats(provider.address, providerLedgers.current[provider.address] ?? 0)] as const),
    );
    if (!mounted.current || request !== providerRequest.current) return;
    setProviderStats(Object.fromEntries(entries));
  }, []);

  const refreshAfterLiquidity = useCallback(async (account: string, ledger: number) => {
    if (!mounted.current || currentWallet.current !== account) return;
    providerLedgers.current[account] = Math.max(providerLedgers.current[account] ?? 0, ledger);
    setStaleBalanceWallet(account);
    setProviderStats({});
    const results = await Promise.allSettled([refreshBalances(account), refreshProviders()]);
    if (results.some(result => result.status === 'rejected')) throw new Error('Liquidity confirmed; balance refresh unavailable.');
  }, [refreshBalances, refreshProviders]);

  const refreshRecipientTrustline = useCallback(async () => {
    if (recipientError(recipient)) {
      setRecipientTrustline(null);
      return;
    }
    const request = ++trustRequest.current.recipient;
    try {
      const status = await checkTrustline(recipient, target);
      if (request === trustRequest.current.recipient) setRecipientTrustline(status);
    } catch {
      if (request === trustRequest.current.recipient) setRecipientTrustline(null);
    }
  }, [recipient, target]);

  const refreshSenderTrustline = useCallback(async () => {
    if (!walletAddress) {
      setSenderTrustline(null);
      return;
    }
    const request = ++trustRequest.current.sender;
    try {
      const status = await checkTrustline(walletAddress, source);
      if (request === trustRequest.current.sender) setSenderTrustline(status);
    } catch {
      if (request === trustRequest.current.sender) setSenderTrustline(null);
    }
  }, [source, walletAddress]);

  const refreshQuote = useCallback(async () => {
    const request = ++quoteRequest.current;
    if (sendLock.current || paymentRef.current) { setQuoteLoading(false); return; }
    setQuoteError('');
    if (amountIn <= 0n || source === target) {
      setQuote(null);
      setQuoteLoading(false);
      return;
    }
    setQuoteLoading(true);
    try {
      const next = await getQuote(walletAddress || VIEW_ACCOUNT, source, target, amountIn);
      if (request !== quoteRequest.current) return;
      setQuote(next);
      lastFetch.current = { quote: next, at: Math.floor(Date.now() / 1000) };
    } catch (error) {
      if (request !== quoteRequest.current) return;
      setQuote(null);
      if (process.env.NODE_ENV === 'development') {
        const failure = error as {method?: string; contractCode?: number};
        console.warn('Veldora quote unavailable', {method:failure?.method, contractCode:failure?.contractCode, source, target, amountIn:amountIn.toString()});
      }
      setQuoteError(error instanceof Error ? error.message : 'Quote unavailable. Refresh to try again.');
    } finally {
      if (request === quoteRequest.current) setQuoteLoading(false);
    }
  }, [amountIn, source, target, walletAddress]);

  const invalidateQuote = useCallback(() => { ++quoteRequest.current; }, []);
  useEffect(() => {
    invalidateQuote();
    const clear = window.setTimeout(() => { setQuote(null); setQuoteLoading(true); }, 0);
    const timer = window.setTimeout(refreshQuote, 350);
    return () => { invalidateQuote(); window.clearTimeout(timer); window.clearTimeout(clear); };
  }, [refreshQuote, invalidateQuote, anchorPayment?.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      refreshRecipientTrustline().catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [refreshRecipientTrustline]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      refreshSenderTrustline().catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshSenderTrustline]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => {
      refreshProviders().catch(() => undefined);
    }, 0);
    const interval = window.setInterval(() => {
      refreshProviders().catch(() => undefined);
    }, 30_000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
    };
  }, [refreshProviders]);

  useEffect(() => {
    const updateClock = () => setCurrentTimestamp(Math.floor(Date.now() / 1_000));
    const initialClock = window.setTimeout(updateClock, 0);
    const interval = window.setInterval(updateClock, 1_000);
    return () => {
      window.clearTimeout(initialClock);
      window.clearInterval(interval);
    };
  }, []);

  // An expired quote refreshes itself once. A quote that was already stale when it arrived
  // (e.g. an old oracle price) stays expired, so the reason is shown instead of looping.
  const quoteExpired = !!storedQuote && storedQuote.requestKey === requestKey && currentTimestamp > storedQuote.validUntil;
  useEffect(() => {
    const fetched = lastFetch.current;
    if (!quoteExpired || !storedQuote || fetched.quote !== storedQuote || storedQuote.validUntil <= fetched.at || action !== null) return;
    const timer = window.setTimeout(() => {
      if (lastFetch.current.quote !== storedQuote || paymentRef.current) return;
      lastFetch.current = { quote: null, at: 0 };
      void refreshQuote();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [quoteExpired, storedQuote, action, refreshQuote]);

  function chooseRecipient(value: string, from: 'manual' | 'wallet') {
    ++trustRequest.current.recipient;
    setRecipientTrustline(null);
    setRecipient(value);
    setRecipientSource(from);
  }
  /** A recipient copied from the old account is cleared, never silently kept; a typed one stays. */
  function accountChanged(next: string) {
    if (recipientSource === 'wallet' && recipient !== next) chooseRecipient('', 'manual');
  }

  async function connect() {
    setAction('connect');
    setNotice(null);
    try {
      const address = await connectWallet();
      accountChanged(address);
      if (walletAddress && address !== walletAddress) {
        setAnchorPayment(null);
        setReceipt(null);
        setNotice({ tone: 'error', text: 'Wallet changed. The previous Anchor flow was stopped. Check its order with the original wallet before starting another.' });
      }
      currentWallet.current = address;
      setWalletAddress(address);
      setBalances(EMPTY_BALANCES);
      await refreshBalances(address);
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setAction(null);
    }
  }

  /** Only the account itself can authorize its own trustline. */
  async function addTrustline(assetKey: AssetKey) {
    if (!walletAddress) return connect();
    setAction('trustline');
    setNotice(null);
    try {
      await ensureTrustline(walletAddress, assetKey);
      await Promise.all([
        refreshBalances(walletAddress),
        refreshSenderTrustline(),
        refreshRecipientTrustline(),
      ]);
      setNotice({
        tone: 'success',
        text: `${ASSETS[assetKey].code} trustline added to your wallet.`,
      });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setAction(null);
    }
  }

  function clearSelection(changed?: 'source' | 'target' | 'both') {
    ++quoteRequest.current;
    if (changed === 'source' || changed === 'both') { ++trustRequest.current.sender; setSenderTrustline(null); }
    if (changed === 'target' || changed === 'both') { ++trustRequest.current.recipient; setRecipientTrustline(null); }
    setQuote(null); setQuoteError(''); setNotice(null); setAnchorPayment(null);
  }
  function reversePair() {
    clearSelection('both');
    setSource(target);
    setTarget(source);
    setReceipt(null);
  }

  async function swap() {
    if (!walletAddress) return connect();
    if (!quote || amountIn <= 0n || recipientProblem || source === target || action !== null || sendLock.current || paymentRef.current || recoveryError || walletBalanceUnavailable) return;
    sendLock.current = true; ++quoteRequest.current;
    setAction('swap');
    setNotice(null);
    setReceipt(null);
    try {
      // The router is a contract address and holds SAC balances directly, but
      // the recipient may be a classic account that first needs a trustline.
      const trustline = await checkTrustline(recipient, target, quote.amountOut);
      setRecipientTrustline(trustline);
      if (trustline.state === 'missing') {
        throw new Error(
          `The recipient has no ${ASSETS[target].code} trustline yet, so the transfer would fail.`,
        );
      }
      if (trustline.state === 'blocked' || trustline.state === 'unknown') throw new Error(trustline.reason);
      if (trustline.state === 'account-missing') {
        throw new Error('The recipient account does not exist on Stellar Testnet.');
      }

      const [senderBefore, recipientBefore] = await Promise.all([
        getTokenBalance(ASSETS[source].contract, walletAddress),
        getTokenBalance(ASSETS[target].contract, recipient),
      ]);
      const available = await getWalletBalances(walletAddress);
      if (available[source] < amountIn) throw new Error('Insufficient available source balance.');
      if (!isCurrentQuote(quote, requestKey, Math.floor(Date.now()/1000))) throw new Error('The quote expired. Refresh and try again.');
      const minAmountOut = (quote.amountOut * 9_950n) / 10_000n;
      // Re-quote on chain right before signing: route, liquidity and prices must still
      // deliver at least the minimum the user reviewed.
      const fresh = await getQuote(walletAddress, source, target, amountIn);
      if (fresh.amountOut < minAmountOut) {
        setQuote(fresh);
        lastFetch.current = { quote: fresh, at: Math.floor(Date.now() / 1000) };
        throw new Error('The rate moved more than 0.5% since this quote. Review the refreshed quote and send again.');
      }
      // The signer must still be the account shown as "From wallet" in the review.
      try { await assertConnectedWallet(walletAddress); }
      catch {
        accountChanged('');
        currentWallet.current = '';
        setWalletAddress(''); setBalances(EMPTY_BALANCES);
        throw new Error('Your wallet account changed or disconnected. Reconnect and review the payment again.');
      }
      const result = await executeSwap(
        walletAddress,
        recipient,
        source,
        target,
        amountIn,
        minAmountOut,
        rememberPayment,
      );
      setReceipt({source, target, hash:result.hash, senderBefore, recipientBefore, senderAfter:null, recipientAfter:null,
        quote:{...quote,...result.actual}, networkFee:result.networkFee});
      setNotice({tone:'success',text:'Swap and transfer settled atomically on Stellar Testnet.'});
      const refreshed = await Promise.allSettled([refreshBalances(walletAddress), refreshProviders(),
        getTokenBalance(ASSETS[source].contract,walletAddress), getTokenBalance(ASSETS[target].contract,recipient)]);
      setReceipt(previous => previous && {...previous,
        senderAfter:refreshed[2].status==='fulfilled'?refreshed[2].value:null,
        recipientAfter:refreshed[3].status==='fulfilled'?refreshed[3].value:null});
      if(refreshed.some(r=>r.status==='rejected')) setNotice({tone:'success',text:'Payment confirmed. Some balance/liquidity displays could not refresh; the receipt remains valid.'});
    } catch (error) {
      const status=(paymentRef.current as SendPayment | null)?.status;
      setNotice({tone:status==='success'?'success':status==='pending'?'pending':'error',
        text:status==='success'?'Payment confirmed. Receipt details could not refresh; check the confirmed hash.':status==='pending'?'Result not yet confirmed. Check the saved transaction before starting another payment.':errorMessage(error)});
    } finally { sendLock.current=false; setAction(null); }
  }

  async function checkPayment() {
    const saved=paymentRef.current;
    if(!saved || sendLock.current) return;
    sendLock.current=true; setAction('swap');
    try {
      const result=await checkSendTransaction(saved,rememberPayment);
      if(walletAddress) void refreshBalances(walletAddress).catch(()=>undefined);
      void refreshProviders().catch(()=>undefined);
      if(result) {
        setReceipt({source:saved.source,target:saved.target,hash:saved.hash,senderBefore:null,senderAfter:null,recipientBefore:null,recipientAfter:null,
          quote:{...result.actual,requestKey:'',validUntil:0,demo:saved.source==='TRY'||saved.target==='TRY'},networkFee:result.networkFee});
        setNotice({tone:'success',text:'Payment confirmed on Stellar Testnet. Start a new payment only when ready.'});
      }
    } catch(error) {
      const settled=paymentRef.current?.status;
      if(walletAddress && settled && settled!=='pending') void refreshBalances(walletAddress).catch(()=>undefined);
      setNotice({tone:settled==='success'?'success':settled==='failed'||settled==='expired'?'error':'pending',
      text:paymentRef.current?.status==='success'?'Payment confirmed. See the transaction hash for receipt details.':errorMessage(error)});}
    finally {sendLock.current=false;setAction(null);}
  }
  function newPayment() {
    try {clearPayment();paymentRef.current=null;setPayment(null);setReceipt(null);setNotice(null);setAnchorPayment(null);void refreshQuote();}
    catch(error) {setNotice({tone:'error',text:errorMessage(error)});}
  }

  const oracleRate = quote ? formatAmount(quote.amountOut * 10_000_000n / quote.amountIn, 7) : '—';
  const oracleTimestamp = quote
    ? Math.min(quote.sourceOracleTimestamp, quote.targetOracleTimestamp)
    : 0;
  const oracleAge = oracleTimestamp
    ? Math.max(0, currentTimestamp - oracleTimestamp)
    : 0;

  return (
    <main className={`veldora-shell app-shell${tab === 'send' ? ' send-active' : ''}`}>
      <header className="app-header">
        <button className="brand" onClick={() => setTab('send')} aria-label="Veldora home"><span>V</span>eldora.</button>
        <nav aria-label="Main navigation" className="app-nav">
          {(['send', 'fund', 'liquidity'] as const).map(item => <button key={item} id={`nav-${item}`} aria-current={tab === item ? 'page' : undefined} aria-controls={`panel-${item}`} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
        </nav>
        <div className="header-wallet"><span className="network-badge">● Testnet</span><Button onClick={connect} disabled={action !== null}>{action === 'connect' ? <LoaderCircle className="animate-spin" /> : <Wallet />}{walletAddress ? shorten(walletAddress) : 'Connect wallet'}</Button></div>
      </header>
      <div className="app-workspace">
        <section id="panel-send" aria-labelledby="nav-send" hidden={tab !== 'send'} className="tab-panel">
          <h1 className="sr-only">Swap &amp; send</h1>
          <div className="send-layout">
            <div className="payment-shell">
          <Card className="gap-0 rounded-none border-0 bg-white py-0 shadow-none ring-0">
            <CardContent className="send-form">
              <div className="reference-rate">
                <h2>Effective rate · after LP fees</h2>
                <p>{quote ? `1 ${source} = ${oracleRate} ${target}` : amountIn <= 0n ? (amountProblem ? 'Check the amount' : 'Enter an amount') : source === target ? 'Choose different currencies' : storedQuote && currentTimestamp > storedQuote.validUntil ? 'Quote expired — refresh to continue' : quoteLoading ? 'Fetching reference rate…' : 'Reference rate unavailable'}</p>
              </div>

              <div className="currency-box">
                <div className="mb-1 flex items-center justify-between text-xs text-[#64786e]">
                  <label htmlFor="send-amount">You send</label>
                  <span>Balance {walletBalanceUnavailable ? 'unavailable' : walletAddress ? `${formatAmount(balances[source])} ${ASSETS[source].code}` : '—'}</span>
                </div>
                <div className="flex gap-3">
                  <Input
                    id="send-amount"
                    value={amount}
                    inputMode="decimal"
                    aria-label="Amount to send"
                    aria-invalid={amountProblem ? true : undefined}
                    aria-describedby={amountProblem ? 'send-amount-error' : undefined}
                    disabled={action !== null || !!payment || !!recoveryError}
                    onChange={(event) => { if (parseAmount(event.target.value) !== amountIn) clearSelection(); setAmount(event.target.value); }}
                    className="h-14 border-0 bg-transparent px-0 text-3xl font-semibold shadow-none focus-visible:ring-0"
                  />
                  <CurrencySelector value={source} label="You send currency" balances={walletAddress && !walletBalanceUnavailable ? balances : undefined} disabled={action !== null || !!payment || !!recoveryError}
                    onChange={next => { clearSelection('source'); setSource(next); }} />
                </div>
              </div>

              {amountProblem && <p id="send-amount-error" role="alert" className="mt-2 text-sm text-[#a52b2b]">{amountProblem}</p>}

              <div className="reverse-control">
                <button
                  aria-label="Reverse currencies" disabled={action !== null || !!payment || !!recoveryError}
                  onClick={reversePair}
                  className="grid size-10 place-items-center rounded-xl border-4 border-white bg-[#185b48] text-white shadow-sm transition hover:rotate-180 hover:bg-[#104333]"
                >
                  <ArrowDownUp className="size-4" />
                </button>
              </div>

              <div className="currency-box">
                <div className="mb-1 flex items-center justify-between text-xs text-[#64786e]">
                  <span id="receive-label">Recipient receives</span>
                  <span>{quoteLoading ? 'Refreshing quote…' : 'After LP fee'}</span>
                </div>
                <div className="flex min-h-14 items-center justify-between gap-3">
                  {quoteLoading ? (
                    <LoaderCircle className="size-6 animate-spin text-[#185b48]" />
                  ) : (
                    <output aria-labelledby="receive-label" className="receive-amount">{quote ? formatAmount(quote.amountOut) : '—'}</output>
                  )}
                  <CurrencySelector value={target} label="Recipient receives currency" disabled={action !== null || !!payment || !!recoveryError}
                    onChange={next => { clearSelection('target'); setTarget(next); }} />
                </div>
              </div>

              <div className="flex items-center justify-between gap-2">
                <label className="recipient-label" htmlFor="send-recipient">Recipient Stellar address</label>
                <Button type="button" variant="outline" size="sm" disabled={!walletAddress || action !== null || !!payment || !!recoveryError}
                  onClick={() => chooseRecipient(walletAddress, 'wallet')}>Use my wallet</Button>
              </div>
              <Input
                id="send-recipient"
                value={recipient}
                aria-invalid={recipient && recipientProblem ? true : undefined}
                aria-describedby={recipient && recipientProblem ? 'send-recipient-error' : undefined}
                disabled={action !== null || !!payment || !!recoveryError} onChange={(event) => chooseRecipient(event.target.value.trim(), 'manual')}
                className="recipient-input h-11 rounded-xl border-[#dce5df] bg-white font-mono text-xs"
                placeholder="Recipient Stellar address (G... or C...)"
                aria-label="Recipient Stellar address"
              />
              {recipient && recipientProblem && <p id="send-recipient-error" role="alert" className="mt-2 text-sm text-[#a52b2b]">{recipientProblem}</p>}

              {source === target && <p role="alert" className="mt-3 text-sm">Choose different currencies for FX send.</p>}
              <dl className="quote-summary">
                <div><dt>Route</dt><dd>{quote ? quote.path.map(id => Object.values(ASSETS).find(a => a.contract === id)?.currency).join(' → ') : '—'}</dd></div>
                <div><dt>Network fee</dt><dd>XLM · confirmed in wallet before signing</dd></div>
                <div><dt>Minimum received <span>(0.5% slippage)</span></dt><dd>{quote ? `${formatAmount((quote.amountOut * 9_950n) / 10_000n, 7)} ${ASSETS[target].code}` : '—'}</dd></div>
              </dl>

              {quote && <details className="mt-3 text-sm"><summary className="cursor-pointer">Route details</summary>
                <p className="my-2 text-xs text-muted-foreground">Highest net output within available Veldora liquidity. XLM network fee is separate.</p>
                {quote.hops.map((hop, i) => <p key={i} className="my-2 break-all">{Object.values(ASSETS).find(a => a.contract === quote.path[i])?.currency} → {Object.values(ASSETS).find(a => a.contract === quote.path[i+1])?.currency} · LP {shorten(hop.provider)} · Fee {formatAmount(hop.feeAmount,7)} {Object.values(ASSETS).find(a => a.contract === quote.path[i+1])?.currency} ({hop.feeBps} bps)</p>)}
                <p>{quote.demo ? 'TRY demo/mock feed + Reflector testnet feeds' : 'Reflector testnet feeds'} · Valid until {new Date(quote.validUntil*1000).toLocaleTimeString()}</p>
                {quote.path.map(id => {const a=Object.values(ASSETS).find(a=>a.contract===id); return <p key={id} className="my-2 break-all font-mono text-xs">{a?.code} · {a?.issuer}<br/>{id}<br/>Oracle {a?.oracleSymbol}: {a?.oracle} ({a?.priceMode === 'demo' ? 'demo/mock feed' : a?.priceMode})</p>;})}
              </details>}
              {recipientTrustline?.state === 'account-missing' && <p role="alert" className="mt-3 text-sm">The recipient account must be funded on Stellar Testnet before receiving this asset.</p>}
              {(senderTrustline?.state === 'blocked' || senderTrustline?.state === 'unknown') && <p role="alert" className="mt-3 text-sm">{senderTrustline.reason}</p>}
              {(recipientTrustline?.state === 'blocked' || recipientTrustline?.state === 'unknown') && <p role="alert" className="mt-3 text-sm">{recipientTrustline.reason}</p>}
              {recipientNeedsTrustline && (
                <div className="mt-2 flex items-start gap-2 rounded-xl bg-[#fff8e8] px-3 py-2.5 text-sm text-[#8a5a00]">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  <span>
                    The recipient has no {ASSETS[target].code} trustline.{' '}
                    {recipientIsWallet
                      ? 'Add it below to receive this payment.'
                      : 'They must add it themselves before this transfer can settle.'}
                  </span>
                </div>
              )}

              {quoteError && amountIn > 0n && source !== target && !payment && <p role="alert" className="mt-3 text-sm">{quoteError}</p>}
              {recoveryError && <p role="alert">{recoveryError}</p>}
              {notice && (
                <div role={notice.tone === 'error' ? 'alert' : 'status'} className={`mt-2 flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm ${notice.tone === 'success' ? 'bg-[#eaf9f2] text-[#076b4b]' : 'bg-[#fff1f1] text-[#a52b2b]'}`}>
                  {notice.tone === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <CircleAlert className="mt-0.5 size-4 shrink-0" />}
                  <span>{notice.text}</span>
                </div>
              )}

              {walletAddress && quote && !recipientProblem && !payment && (
                <dl className="quote-summary" aria-label="Review before signing">
                  <div><dt>From wallet</dt><dd className="break-all font-mono text-xs">{walletAddress}</dd></div>
                  <div><dt>You send</dt><dd>{formatAmount(amountIn, 7)} {ASSETS[source].code}</dd></div>
                  <div><dt>Recipient{recipientIsWallet ? ' (your wallet)' : ''}</dt><dd className="break-all font-mono text-xs">{recipient}</dd></div>
                  <div><dt>Recipient receives</dt><dd>≈ {formatAmount(quote.amountOut, 7)} {ASSETS[target].code} · min {formatAmount((quote.amountOut * 9_950n) / 10_000n, 7)}</dd></div>
                </dl>
              )}
              {walletAddress && recipient && !recipientProblem && !recipientIsWallet && !payment && <output className="block text-xs text-[#8a5a00]">This sends to another address, not your connected wallet.</output>}
              {payment ? <output className="mt-3 block text-sm">
                <p>{payment.status==='success'?'Payment confirmed':payment.status==='failed'?'Transaction failed — no payment delivered':payment.status==='expired'?'Transaction expired without executing — no payment delivered':'Result not yet confirmed — do not repeat this payment'}</p>
                <p>{savedAmount(payment.amount)} {ASSETS[payment.source].code} → {ASSETS[payment.target].code} · Recipient {shorten(payment.recipient)}</p>
                <p>Wallet {shorten(payment.wallet)} · Testnet · Router {shorten(payment.router)}</p>
                <a className="underline break-all" href={`${EXPLORER_URL}/tx/${payment.hash}`} target="_blank" rel="noreferrer">{payment.hash}</a>
                <Button onClick={checkPayment} disabled={action!==null}>Check transaction</Button>
                {payment.status!=='pending' && <Button onClick={newPayment} disabled={action!==null}>New payment</Button>}
              </output> : !walletAddress ? (
                <Button className="mt-3 h-11 w-full rounded-xl bg-[#185b48] text-base hover:bg-[#104333]" onClick={connect} disabled={action !== null || !!payment || !!recoveryError}>
                  <Wallet /> Swap &amp; send
                </Button>
              ) : senderNeedsTrustline ? (
                <Button className="mt-3 h-11 w-full rounded-xl bg-[#185b48] text-base hover:bg-[#104333]" onClick={() => addTrustline(source)} disabled={action !== null || !!payment || !!recoveryError}>
                  {action === 'trustline' ? <LoaderCircle className="animate-spin" /> : <LinkIcon />}
                  Add {ASSETS[source].code} trustline
                </Button>
              ) : recipientNeedsTrustline && recipientIsWallet ? (
                <Button className="mt-3 h-11 w-full rounded-xl bg-[#185b48] text-base hover:bg-[#104333]" onClick={() => addTrustline(target)} disabled={action !== null || !!payment || !!recoveryError}>
                  {action === 'trustline' ? <LoaderCircle className="animate-spin" /> : <LinkIcon />}
                  Add {ASSETS[target].code} trustline
                </Button>
              ) : (
                <Button
                  className="mt-3 h-11 w-full rounded-xl bg-[#185b48] text-base hover:bg-[#104333]"
                  onClick={swap}
                  disabled={
                    action !== null || !!recoveryError || source === target || amountIn <= 0n ||
                    quoteLoading || walletBalanceUnavailable ||
                    !quote ||
                    !!recipientProblem ||
                    !['present','not-required'].includes(recipientTrustline?.state ?? '') ||
                    !['present','not-required'].includes(senderTrustline?.state ?? '') ||
                    balances[source] < amountIn
                  }
                >
                  {action === 'swap' ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
                  {action === 'swap'
                    ? 'Settling on Stellar…'
                    : walletBalanceUnavailable ? 'Balance unavailable'
                    : balances[source] < amountIn
                      ? `Not enough ${ASSETS[source].code}`
                      : 'Swap & send'}
                </Button>
              )}
              {walletAddress && !walletBalanceUnavailable && !senderNeedsTrustline && balances[source] < amountIn && (
                <p className="mt-2 text-center text-[11px] text-[#718478]">
                  {senderTrustline?.state === 'account-missing'
                    ? 'This wallet is not funded on Stellar Testnet yet. Fund it with Friendbot (XLM), then add funds.'
                    : `Fund this wallet with real Stellar Testnet ${ASSETS[source].code} to continue.`}
                </p>
              )}
              <p className="mt-2 text-center text-[11px] text-[#718478]">{walletAddress ? 'Atomic swap + recipient transfer · 3 minute deadline' : 'Connect your wallet to continue · Stellar Testnet'}</p>
              <div className="oracle-status">
                <span className={quote && oracleAge > 900 ? 'text-amber-800' : ''}>{quote ? `${quote.demoFeed ? `TRY demo/mock feed · set ${minutesSince(quote.demoFeed.setAt, currentTimestamp)} min ago` : `${quote.demo ? 'Demo + live testnet' : 'Live testnet'} · ${oracleAge}s ago`} · ${Math.max(0,quote.validUntil-currentTimestamp)}s remaining` : 'Reflector · No current quote'}</span>
                <button onClick={() => refreshQuote()} disabled={quoteLoading || action!==null || !!payment || amountIn<=0n || source===target} aria-label="Refresh quote"><RefreshCw className={`size-3 ${quoteLoading ? 'animate-spin' : ''}`} /> Refresh</button>
              </div>
            </CardContent>
          </Card>
          <details className="send-details"><summary>Details <span>Contracts, liquidity &amp; receipts{receipt ? ' · New receipt' : ''}</span></summary>
          {receipt && (
            <details className="receipt-details"><summary>✓ Veldora settlement complete · {formatAmount(receipt.quote.amountOut, 7)} {ASSETS[receipt.target].code} received <a href={`${EXPLORER_URL}/tx/${receipt.hash}`} target="_blank" rel="noreferrer">View tx ↗</a></summary><Card className="border-0 shadow-none ring-0">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-[#087151]"><CheckCircle2 className="size-5" /> Veldora settlement complete</CardTitle>
                    <CardDescription>Only the Veldora swap and recipient transfer finalized in this atomic transaction. Anchor is a separate leg.</CardDescription>
                  </div>
                  <a href={`${EXPLORER_URL}/tx/${receipt.hash}`} target="_blank" rel="noreferrer" className="text-[#185b48]" aria-label="Open transaction in Stellar Expert"><ExternalLink className="size-5" /></a>
                </div>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
                <div className="rounded-xl bg-[#f1f5ef] p-3"><span className="text-xs text-[#64786e]">Sender {ASSETS[receipt.source].code}</span><p className="mt-1 font-medium">{receipt.senderBefore===null?'—':formatAmount(receipt.senderBefore, 7)} → {receipt.senderAfter===null?'—':formatAmount(receipt.senderAfter, 7)}</p></div>
                <div className="rounded-xl bg-[#f1f5ef] p-3"><span className="text-xs text-[#64786e]">Recipient {ASSETS[receipt.target].code}</span><p className="mt-1 font-medium">{receipt.recipientBefore===null?'—':formatAmount(receipt.recipientBefore, 7)} → {receipt.recipientAfter===null?'—':formatAmount(receipt.recipientAfter, 7)}</p></div>
                <p className="break-all sm:col-span-2">Executed {receipt.quote.path.map(id=>Object.values(ASSETS).find(a=>a.contract===id)?.currency).join(' → ')} · {formatAmount(receipt.quote.amountIn,7)} {receipt.source} → {formatAmount(receipt.quote.amountOut,7)} {receipt.target}</p>
                <div className="rounded-xl bg-[#f1f5ef] p-3"><span className="text-xs text-[#64786e]">Executed route fees</span><p className="mt-1 font-medium">{receipt.quote.hops.map((h,i) => `${formatAmount(h.feeAmount,7)} ${Object.values(ASSETS).find(a=>a.contract===receipt.quote.path[i+1])?.currency}`).join(' · ')}</p></div>
                <div className="rounded-xl bg-[#f1f5ef] p-3"><span className="text-xs text-[#64786e]">Provider</span><p className="mt-1 font-medium">{receipt.quote.hops.map(h=>shorten(h.provider)).join(' → ')}</p></div>
                <div className="rounded-xl bg-[#f1f5ef] p-3"><span className="text-xs text-[#64786e]">{receipt.quote.demo ? 'TRY demo/mock price · ' : 'Live testnet · '}Network fee {formatAmount(receipt.networkFee,7)} XLM · Transaction</span><p className="mt-1 font-mono text-xs">{shorten(receipt.hash, 8)}</p></div>
              </CardContent>
            </Card></details>
          )}
        <div className="network-aside">
          <Card className="rounded-2xl border-0 bg-transparent py-3 text-[#152b29] shadow-none ring-0">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Your liquidity network</CardTitle>
                <button aria-label="Refresh liquidity" onClick={() => refreshProviders()} className="text-[#64786e] transition hover:rotate-90 hover:text-[#185b48]"><RefreshCw className="size-4" /></button>
              </div>
              <CardDescription className="text-[#64786e]">A better route, selected for you.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {PROVIDERS.map((provider) => {
                const stats = providerStats[provider.address];
                const isSelected = quote?.hops.some(h => h.provider === provider.address);
                return (
                  <div key={provider.address} className={`rounded-2xl p-4 ring-1 ${isSelected ? 'bg-[#e8efde] ring-[#cbd9b7]' : 'bg-white/60 ring-[#e0e6de]'}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div><span className="font-medium">{provider.name}</span><p className="mt-1 font-mono text-[10px] text-[#64786e]">{shorten(provider.address, 6)}</p></div>
                      {isSelected && <Badge className="bg-[#123d35] text-white">Best route</Badge>}
                    </div>
                    <div className="mt-4 grid grid-cols-3 gap-3 text-xs text-[#64786e]">
                      <span>Fee<strong className="mt-1 block text-sm text-[#152b29]">{quote?.hops.filter(h=>h.provider===provider.address).map(h=>`${h.feeBps} bps`).join(' / ') || '—'}</strong></span>
                      {(Object.keys(ASSETS) as AssetKey[]).map(key=><span key={key}>{ASSETS[key].code}<strong className="mt-1 block text-sm text-[#152b29]">{stats ? formatAmount(stats[key].balance,2) : '—'}</strong></span>)}
                    </div>
                    <div className="mt-3 border-t border-[#d6e0d0] pt-3 text-xs text-[#64786e]">Fees earned <strong>{stats ? (Object.keys(ASSETS) as AssetKey[]).map(key=>`${formatAmount(stats[key].fees,7)} ${ASSETS[key].code}`).join(' · ') : '—'}</strong></div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <details className="technical-details"><summary>Settlement &amp; contracts</summary><Card className="border-0 bg-transparent shadow-none ring-0">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5 text-[#185b48]" /> Settlement details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-[#64786e]">Network</span><Badge className="bg-[#eaf9f2] text-[#07845b]">Testnet</Badge></div>
              <div className="flex justify-between"><span className="text-[#64786e]">Oracle</span><span>Reflector FX</span></div>
              <div className="flex justify-between"><span className="text-[#64786e]">Freshness limit</span><span>15 min (Reflector) · TRY demo feed 24 h</span></div>
              <div className="flex justify-between"><span className="text-[#64786e]">Assets</span><span>Four distinct testnet SACs</span></div>
              <div className="space-y-2 pt-1">
                {([
                  ['FX router', FX_ROUTER],
                  ['Reflector oracle', REFLECTOR_ORACLE],
                  ['TRY demo/mock oracle', ASSETS.TRY.oracle],
                  [ASSETS.USD.code, ASSETS.USD.contract],
                  [ASSETS.EUR.code, ASSETS.EUR.contract],
                ] as const).map(([label, contractId]) => (
                  <a
                    key={contractId}
                    href={`${EXPLORER_URL}/contract/${contractId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between gap-3 rounded-xl bg-[#f1f5ef] p-3 text-[#185b48] hover:bg-[#e8efde]"
                  >
                    <span className="text-xs text-[#64786e]">{label}</span>
                    <span className="ml-auto font-mono text-xs">{shorten(contractId, 6)}</span>
                    <ExternalLink className="size-4 shrink-0" />
                  </a>
                ))}
              </div>
            </CardContent>
          </Card></details>
        </div>
          </details>
            </div>
          </div>
        </section>
        <section id="panel-fund" aria-labelledby="nav-fund" hidden={tab !== 'fund'} className="tab-panel fund-panel">
          <div className="panel-heading"><div><p className="eyebrow">ADD FUNDS</p><h1>From lira to your wallet.</h1><p>TRY → USDC with Mock Anchor. Then send with Veldora.</p></div><span className="journey-caption">TRY <span>→</span> USDC</span></div>
          <div className="fund-card">
          <AnchorOnrampCard key={walletAddress} wallet={walletAddress} onContinue={() => setTab('send')} onVerified={(payment) => {
            if (payment.destination_address !== walletAddress || paymentRef.current || anchorPayment?.id === payment.id) return;
            ++quoteRequest.current;
            setQuote(null);
            setQuoteLoading(true);
            setAnchorPayment(payment);
            setSource('USD');
            setTarget('EUR');
            setAmount(payment.amount_usdc);
            setReceipt(null);
            void refreshBalances(walletAddress).catch(() => setNotice({ tone: 'error', text: 'USDC received; wallet balance refresh failed. Reconnect to refresh before swapping.' }));
          }} />
          </div>
        </section>
        <section id="panel-liquidity" aria-labelledby="nav-liquidity" hidden={tab !== 'liquidity'} className="tab-panel">
          <LiquidityPanel key={`testnet:${FX_ROUTER}:${walletAddress}`} wallet={walletAddress} connect={() => void connect()}
            visible={tab === 'liquidity'} onConfirmed={refreshAfterLiquidity} />
        </section>
      </div>
      <footer className="app-footer"><span>Built on Stellar <span aria-hidden="true">↗</span></span><span>Testnet demo · Assets have no monetary value</span></footer>
    </main>
  );
}
