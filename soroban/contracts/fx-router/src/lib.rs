#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, Env, Symbol, Vec,
};

const BPS_SCALE: i128 = 10_000;
const PRICE_DECIMALS: u32 = 14;
const MAX_TOKEN_DECIMALS: u32 = 18;
const MAX_ORACLE_DECIMALS: u32 = 18;
const MAX_PROVIDER_FEE_BPS: u32 = 1_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OracleAsset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contractclient(name = "PriceOracleClient")]
pub trait PriceOracle {
    fn decimals(env: Env) -> u32;
    fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData>;
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetConfig {
    pub enabled: bool,
    pub is_oracle_base: bool,
    pub oracle: Address,
    pub oracle_asset: OracleAsset,
    pub oracle_base: Symbol,
    pub token_decimals: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PairConfig {
    pub active: bool,
    pub fee_bps: u32,
    pub max_amount_in: i128,
    pub max_source_inventory: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Quote {
    pub provider: Address,
    pub amount_in: i128,
    pub gross_amount_out: i128,
    pub amount_out: i128,
    pub fee_amount: i128,
    pub fee_bps: u32,
    pub source_price: i128,
    pub target_price: i128,
    pub source_oracle_timestamp: u64,
    pub target_oracle_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouteQuote {
    pub path: Vec<Address>,
    pub hops: Vec<Quote>,
    pub amount_in: i128,
    pub amount_out: i128,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Hub,
    Paused,
    MaxPriceAge,
    Providers,
    Asset(Address),
    Pair(Address, Address, Address),
    Balance(Address, Address),
    Fees(Address, Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    InvalidConfiguration = 2,
    AssetDisabled = 3,
    PairDisabled = 4,
    ProviderExists = 5,
    ProviderMissing = 6,
    InsufficientBalance = 7,
    NoLiquidity = 8,
    OraclePriceMissing = 9,
    OraclePriceStale = 10,
    OracleBaseMismatch = 11,
    DeadlineExpired = 12,
    SlippageExceeded = 13,
    ContractPaused = 14,
    MathOverflow = 15,
}

#[contract]
pub struct FxRouter;

#[contractimpl]
impl FxRouter {
    pub fn __constructor(env: Env, admin: Address, max_price_age: u64) {
        if max_price_age == 0 {
            panic!("max_price_age must be positive");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .set(&DataKey::MaxPriceAge, &max_price_age);
        env.storage()
            .instance()
            .set(&DataKey::Providers, &Vec::<Address>::new(&env));
    }

    pub fn set_asset(env: Env, asset: Address, config: AssetConfig) -> Result<(), Error> {
        require_admin(&env);
        if config.token_decimals > MAX_TOKEN_DECIMALS {
            return Err(Error::InvalidConfiguration);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Asset(asset.clone()), &config);
        env.events()
            .publish((symbol_short!("asset"), asset), config);
        Ok(())
    }

    pub fn register_provider(env: Env, provider: Address) -> Result<(), Error> {
        provider.require_auth();
        let mut current_providers = providers(&env);
        if provider_registered(&current_providers, &provider) {
            return Err(Error::ProviderExists);
        }
        current_providers.push_back(provider.clone());
        env.storage()
            .instance()
            .set(&DataKey::Providers, &current_providers);
        env.events()
            .publish((symbol_short!("provider"), provider), true);
        Ok(())
    }

    pub fn set_provider_pair(
        env: Env,
        provider: Address,
        source: Address,
        target: Address,
        config: PairConfig,
    ) -> Result<(), Error> {
        provider.require_auth();
        if !provider_registered(&providers(&env), &provider) {
            return Err(Error::ProviderMissing);
        }
        if source == target
            || config.fee_bps > MAX_PROVIDER_FEE_BPS
            || config.max_amount_in < 0
            || config.max_source_inventory < 0
        {
            return Err(Error::InvalidConfiguration);
        }
        require_asset(&env, &source)?;
        require_asset(&env, &target)?;

        let key = DataKey::Pair(provider.clone(), source.clone(), target.clone());
        env.storage().persistent().set(&key, &config);
        env.events().publish(
            (symbol_short!("pair"), provider),
            (source, target, config),
        );
        Ok(())
    }

    pub fn deposit(
        env: Env,
        provider: Address,
        asset: Address,
        amount: i128,
    ) -> Result<i128, Error> {
        provider.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if !provider_registered(&providers(&env), &provider) {
            return Err(Error::ProviderMissing);
        }
        require_asset(&env, &asset)?;

        token::Client::new(&env, &asset).transfer(
            &provider,
            &env.current_contract_address(),
            &amount,
        );
        let next = add_balance(&env, &provider, &asset, amount)?;
        env.events().publish(
            (symbol_short!("deposit"), provider, asset),
            (amount, next),
        );
        Ok(next)
    }

    pub fn withdraw(
        env: Env,
        provider: Address,
        asset: Address,
        amount: i128,
    ) -> Result<i128, Error> {
        provider.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let current = balance(&env, &provider, &asset);
        if current < amount {
            return Err(Error::InsufficientBalance);
        }
        let next = current.checked_sub(amount).ok_or(Error::MathOverflow)?;
        set_balance(&env, &provider, &asset, next);
        token::Client::new(&env, &asset).transfer(
            &env.current_contract_address(),
            &provider,
            &amount,
        );
        env.events().publish(
            (symbol_short!("withdraw"), provider, asset),
            (amount, next),
        );
        Ok(next)
    }

    pub fn quote(
        env: Env,
        source: Address,
        target: Address,
        amount_in: i128,
    ) -> Result<Quote, Error> {
        quote_internal(&env, &source, &target, amount_in)
    }

    pub fn transfer_with_swap(
        env: Env,
        sender: Address,
        recipient: Address,
        source: Address,
        target: Address,
        amount_in: i128,
        min_amount_out: i128,
        deadline: u64,
    ) -> Result<Quote, Error> {
        sender.require_auth();
        if env.ledger().timestamp() > deadline {
            return Err(Error::DeadlineExpired);
        }

        let quote = quote_internal(&env, &source, &target, amount_in)?;
        if quote.amount_out < min_amount_out {
            return Err(Error::SlippageExceeded);
        }

        let contract = env.current_contract_address();
        token::Client::new(&env, &source).transfer(&sender, &contract, &amount_in);
        add_balance(&env, &quote.provider, &source, amount_in)?;

        let provider_target_balance = balance(&env, &quote.provider, &target);
        let next_target_balance = provider_target_balance
            .checked_sub(quote.amount_out)
            .ok_or(Error::MathOverflow)?;
        set_balance(&env, &quote.provider, &target, next_target_balance);

        let fees_key = DataKey::Fees(quote.provider.clone(), target.clone());
        let fees = env
            .storage()
            .persistent()
            .get::<_, i128>(&fees_key)
            .unwrap_or(0)
            .checked_add(quote.fee_amount)
            .ok_or(Error::MathOverflow)?;
        env.storage().persistent().set(&fees_key, &fees);

        token::Client::new(&env, &target).transfer(&contract, &recipient, &quote.amount_out);
        env.events().publish(
            (symbol_short!("swap"), quote.provider.clone()),
            (
                sender,
                recipient,
                source,
                target,
                quote.amount_in,
                quote.amount_out,
                quote.fee_amount,
                quote.source_price,
                quote.target_price,
            ),
        );
        Ok(quote)
    }

    // The only permitted intermediate asset. Set once on a separate deployment.
    pub fn set_hub(env: Env, hub: Address) -> Result<(), Error> {
        require_admin(&env);
        let config = require_asset(&env, &hub)?;
        if !config.is_oracle_base || config.oracle_base != Symbol::new(&env, "USD") {
            return Err(Error::InvalidConfiguration);
        }
        if let Some(current) = env.storage().instance().get::<_, Address>(&DataKey::Hub) {
            if current != hub { return Err(Error::InvalidConfiguration); }
        }
        env.storage().instance().set(&DataKey::Hub, &hub);
        Ok(())
    }

    pub fn get_hub(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Hub)
    }

    pub fn get_max_price_age(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::MaxPriceAge).unwrap_or(0)
    }

    pub fn quote_route(env: Env, source: Address, target: Address, amount_in: i128) -> Result<RouteQuote, Error> {
        route_internal(&env, &source, &target, amount_in)
    }

    pub fn transfer_route(env: Env, sender: Address, recipient: Address, source: Address,
        target: Address, amount_in: i128, min_amount_out: i128, deadline: u64) -> Result<RouteQuote, Error> {
        sender.require_auth();
        if env.ledger().timestamp() > deadline { return Err(Error::DeadlineExpired); }
        if min_amount_out < 0 { return Err(Error::InvalidAmount); }
        let route = route_internal(&env, &source, &target, amount_in)?;
        if route.amount_out < min_amount_out { return Err(Error::SlippageExceeded); }
        let contract = env.current_contract_address();
        token::Client::new(&env, &source).transfer(&sender, &contract, &amount_in);
        for (i, hop) in route.hops.iter().enumerate() {
            let from = route.path.get(i as u32).unwrap();
            let to = route.path.get(i as u32 + 1).unwrap();
            add_balance(&env, &hop.provider, &from, hop.amount_in)?;
            add_balance(&env, &hop.provider, &to, -hop.amount_out)?;
            let key = DataKey::Fees(hop.provider.clone(), to);
            let fees = env.storage().persistent().get::<_, i128>(&key).unwrap_or(0)
                .checked_add(hop.fee_amount).ok_or(Error::MathOverflow)?;
            env.storage().persistent().set(&key, &fees);
        }
        // Intermediate USDC is reallocated between LP inventories, never transferred out.
        token::Client::new(&env, &target).transfer(&contract, &recipient, &route.amount_out);
        env.events().publish((symbol_short!("route"), sender, recipient), route.clone());
        Ok(route)
    }

    pub fn set_paused(env: Env, paused: bool) {
        require_admin(&env);
        env.storage().instance().set(&DataKey::Paused, &paused);
        env.events().publish((symbol_short!("paused"),), paused);
    }

    pub fn set_max_price_age(env: Env, max_price_age: u64) -> Result<(), Error> {
        require_admin(&env);
        if max_price_age == 0 {
            return Err(Error::InvalidConfiguration);
        }
        env.storage()
            .instance()
            .set(&DataKey::MaxPriceAge, &max_price_age);
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn get_providers(env: Env) -> Vec<Address> {
        providers(&env)
    }

    pub fn get_asset(env: Env, asset: Address) -> Option<AssetConfig> {
        env.storage().persistent().get(&DataKey::Asset(asset))
    }

    pub fn get_pair(
        env: Env,
        provider: Address,
        source: Address,
        target: Address,
    ) -> Option<PairConfig> {
        env.storage()
            .persistent()
            .get(&DataKey::Pair(provider, source, target))
    }

    pub fn get_balance(env: Env, provider: Address, asset: Address) -> i128 {
        balance(&env, &provider, &asset)
    }

    pub fn get_fees(env: Env, provider: Address, asset: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Fees(provider, asset))
            .unwrap_or(0)
    }
}

fn quote_internal(
    env: &Env,
    source: &Address,
    target: &Address,
    amount_in: i128,
) -> Result<Quote, Error> {
    let candidates = quote_candidates(env, source, target, amount_in, None)?;
    let mut best: Option<Quote> = None;
    for q in candidates.iter() {
        if best.as_ref().map(|b| q.amount_out > b.amount_out).unwrap_or(true) { best = Some(q); }
    }
    best.ok_or(Error::NoLiquidity)
}

fn quote_candidates(env: &Env, source: &Address, target: &Address, amount_in: i128,
    previous: Option<&Quote>) -> Result<Vec<Quote>, Error> {
    if FxRouter::is_paused(env.clone()) {
        return Err(Error::ContractPaused);
    }
    if amount_in <= 0 || source == target {
        return Err(Error::InvalidAmount);
    }

    let source_config = require_asset(env, source)?;
    let target_config = require_asset(env, target)?;
    if source_config.oracle_base != target_config.oracle_base {
        return Err(Error::OracleBaseMismatch);
    }

    let (source_price, source_timestamp) = read_price(env, &source_config)?;
    let (target_price, target_timestamp) = read_price(env, &target_config)?;
    let gross_amount_out = calculate_output(
        amount_in,
        source_price,
        target_price,
        source_config.token_decimals,
        target_config.token_decimals,
    )?;
    if gross_amount_out <= 0 {
        return Err(Error::InvalidAmount);
    }

    let mut candidates = Vec::new(env);
    for provider in providers(env).iter() {
        let pair_key = DataKey::Pair(provider.clone(), source.clone(), target.clone());
        let pair = match env.storage().persistent().get::<_, PairConfig>(&pair_key) {
            Some(value) if value.active => value,
            _ => continue,
        };
        if pair.max_amount_in > 0 && amount_in > pair.max_amount_in {
            continue;
        }

        let source_inventory = balance(env, &provider, source).checked_sub(
            previous.filter(|q| q.provider == provider).map(|q| q.amount_out).unwrap_or(0)
        ).ok_or(Error::MathOverflow)?;
        if pair.max_source_inventory > 0
            && source_inventory
                .checked_add(amount_in)
                .ok_or(Error::MathOverflow)?
                > pair.max_source_inventory
        {
            continue;
        }

        let fee_amount = gross_amount_out
            .checked_mul(pair.fee_bps as i128)
            .ok_or(Error::MathOverflow)?
            .checked_div(BPS_SCALE)
            .ok_or(Error::MathOverflow)?;
        let amount_out = gross_amount_out
            .checked_sub(fee_amount)
            .ok_or(Error::MathOverflow)?;
        if amount_out <= 0 || balance(env, &provider, target) < amount_out {
            continue;
        }

        let candidate = Quote {
            provider,
            amount_in,
            gross_amount_out,
            amount_out,
            fee_amount,
            fee_bps: pair.fee_bps,
            source_price,
            target_price,
            source_oracle_timestamp: source_timestamp,
            target_oracle_timestamp: target_timestamp,
        };
        candidates.push_back(candidate);
    }
    Ok(candidates)
}

fn route_internal(env: &Env, source: &Address, target: &Address, amount_in: i128) -> Result<RouteQuote, Error> {
    let direct = quote_candidates(env, source, target, amount_in, None)?;
    let mut best: Option<RouteQuote> = None;
    // Stable provider registration order breaks exact ties; direct is visited first.
    for q in direct.iter() {
        if best.as_ref().map(|b| q.amount_out > b.amount_out).unwrap_or(true) {
            best = Some(RouteQuote { path: soroban_sdk::vec![env, source.clone(), target.clone()],
                hops: soroban_sdk::vec![env, q.clone()], amount_in, amount_out: q.amount_out });
        }
    }
    if let Some(hub) = FxRouter::get_hub(env.clone()) {
        if hub != *source && hub != *target {
            // A broken intermediate oracle must not disable a valid direct route.
            if let Ok(first) = quote_candidates(env, source, &hub, amount_in, None) {
                for one in first.iter() {
                    if let Ok(second) = quote_candidates(env, &hub, target, one.amount_out, Some(&one)) {
                        for two in second.iter() {
                            if best.as_ref().map(|b| two.amount_out > b.amount_out).unwrap_or(true) {
                                best = Some(RouteQuote { path: soroban_sdk::vec![env, source.clone(), hub.clone(), target.clone()],
                                    hops: soroban_sdk::vec![env, one.clone(), two.clone()], amount_in, amount_out: two.amount_out });
                            }
                        }
                    }
                }
            }
        }
    }
    best.ok_or(Error::NoLiquidity)
}

fn read_price(env: &Env, config: &AssetConfig) -> Result<(i128, u64), Error> {
    if config.is_oracle_base {
        return Ok((pow10(PRICE_DECIMALS)?, env.ledger().timestamp()));
    }

    let oracle = PriceOracleClient::new(env, &config.oracle);
    let decimals = oracle.decimals();
    if decimals > MAX_ORACLE_DECIMALS {
        return Err(Error::InvalidConfiguration);
    }
    let data = oracle
        .lastprice(&config.oracle_asset)
        .ok_or(Error::OraclePriceMissing)?;
    if data.price <= 0 {
        return Err(Error::OraclePriceMissing);
    }

    let now = env.ledger().timestamp();
    let max_age = env
        .storage()
        .instance()
        .get::<_, u64>(&DataKey::MaxPriceAge)
        .unwrap_or(0);
    if data.timestamp > now || now - data.timestamp > max_age {
        return Err(Error::OraclePriceStale);
    }

    let normalized = if decimals < PRICE_DECIMALS {
        data.price
            .checked_mul(pow10(PRICE_DECIMALS - decimals)?)
            .ok_or(Error::MathOverflow)?
    } else {
        data.price
            .checked_div(pow10(decimals - PRICE_DECIMALS)?)
            .ok_or(Error::MathOverflow)?
    };
    if normalized <= 0 { return Err(Error::OraclePriceMissing); }
    Ok((normalized, data.timestamp))
}

fn calculate_output(
    amount_in: i128,
    source_price: i128,
    target_price: i128,
    source_decimals: u32,
    target_decimals: u32,
) -> Result<i128, Error> {
    let numerator = amount_in.checked_mul(source_price).ok_or(Error::MathOverflow)?;
    if target_decimals >= source_decimals {
        numerator.checked_mul(pow10(target_decimals - source_decimals)?).ok_or(Error::MathOverflow)?
            .checked_div(target_price).ok_or(Error::MathOverflow)
    } else {
        numerator.checked_div(target_price).ok_or(Error::MathOverflow)?
            .checked_div(pow10(source_decimals - target_decimals)?).ok_or(Error::MathOverflow)
    }
}

fn pow10(exponent: u32) -> Result<i128, Error> {
    let mut result = 1_i128;
    for _ in 0..exponent {
        result = result.checked_mul(10).ok_or(Error::MathOverflow)?;
    }
    Ok(result)
}

fn require_admin(env: &Env) {
    let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
    admin.require_auth();
}

fn providers(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::Providers)
        .unwrap_or(Vec::new(env))
}

fn provider_registered(current_providers: &Vec<Address>, provider: &Address) -> bool {
    current_providers
        .iter()
        .any(|candidate| candidate == *provider)
}

fn require_asset(env: &Env, asset: &Address) -> Result<AssetConfig, Error> {
    match env
        .storage()
        .persistent()
        .get::<_, AssetConfig>(&DataKey::Asset(asset.clone()))
    {
        Some(config) if config.enabled => Ok(config),
        _ => Err(Error::AssetDisabled),
    }
}

fn balance(env: &Env, provider: &Address, asset: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(provider.clone(), asset.clone()))
        .unwrap_or(0)
}

fn set_balance(env: &Env, provider: &Address, asset: &Address, amount: i128) {
    env.storage().persistent().set(
        &DataKey::Balance(provider.clone(), asset.clone()),
        &amount,
    );
}

fn add_balance(
    env: &Env,
    provider: &Address,
    asset: &Address,
    amount: i128,
) -> Result<i128, Error> {
    let next = balance(env, provider, asset)
        .checked_add(amount)
        .ok_or(Error::MathOverflow)?;
    set_balance(env, provider, asset, next);
    Ok(next)
}

#[cfg(test)]
mod test;
