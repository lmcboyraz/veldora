'use client';
import { ASSETS, type AssetKey } from '@/lib/config';
import { formatAmount } from '@/lib/stellar';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
export function CurrencySelector({ value, onChange, label, balances, disabled }: {
  value: AssetKey; onChange: (value: AssetKey) => void; label: string;
  balances?: Record<AssetKey, bigint>; disabled?: boolean;
}) {
  return <Select value={value} onValueChange={v => { if (v && v in ASSETS) onChange(v as AssetKey); }} disabled={disabled}>
    <SelectTrigger aria-label={label} className="min-h-12 min-w-28 border-0 bg-white text-base font-semibold">
      <span aria-hidden className="grid size-7 place-items-center rounded-full bg-[#eaf2ed] text-[#185b48]">{ASSETS[value].symbol}</span>{value}
    </SelectTrigger>
    <SelectContent align="end" alignItemWithTrigger={false} className="min-w-64 max-w-[calc(100vw-2rem)] p-1">
      {(Object.keys(ASSETS) as AssetKey[]).map(key => <SelectItem key={key} value={key} className="min-h-14 rounded-lg px-3 hover:bg-[#edf5ef] data-selected:bg-[#edf5ef]">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-[#eaf2ed] text-[#185b48]">{ASSETS[key].symbol}</span>
        <span className="flex flex-1 flex-col"><span className="font-semibold">{key} <span className="font-normal text-muted-foreground">{key === 'USD' ? 'US dollar' : key === 'EUR' ? 'Euro' : ASSETS[key].label}</span></span>
          <span className="text-xs text-muted-foreground">{balances ? `Available ${formatAmount(balances[key],7)}` : ASSETS[key].code}{ASSETS[key].priceMode === 'demo' ? ' · Demo token · mock price feed' : ASSETS[key].demo ? ' · Demo token' : ''}</span>
        </span>
      </SelectItem>)}
    </SelectContent>
  </Select>;
}
