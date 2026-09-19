use super::*;
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    IntoVal,
};

fn authorize(
    env: &Env,
    signer: &Address,
    contract: &Address,
    name: &'static str,
    args: Vec<soroban_sdk::Val>,
) {
    env.mock_auths(&[MockAuth {
        address: signer,
        invoke: &MockAuthInvoke {
            contract,
            fn_name: name,
            args,
            sub_invokes: &[],
        },
    }]);
}

#[test]
fn provider_can_self_register_and_duplicates_are_rejected() {
    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    let admin = Address::generate(&env);
    let provider = Address::generate(&env);
    let id = env.register(FxRouter, (admin, 900u64));
    let client = FxRouterClient::new(&env, &id);
    authorize(
        &env,
        &provider,
        &id,
        "register_provider",
        (provider.clone(),).into_val(&env),
    );
    client.register_provider(&provider);
    assert_eq!(
        client.get_providers(),
        soroban_sdk::vec![&env, provider.clone()]
    );
    authorize(
        &env,
        &provider,
        &id,
        "register_provider",
        (provider.clone(),).into_val(&env),
    );
    assert_eq!(
        client.try_register_provider(&provider),
        Err(Ok(Error::ProviderExists))
    );
}

#[test]
fn registration_requires_the_providers_own_authorization() {
    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    let admin = Address::generate(&env);
    let provider = Address::generate(&env);
    let id = env.register(FxRouter, (admin.clone(), 900u64));
    let client = FxRouterClient::new(&env, &id);
    assert!(client.try_register_provider(&provider).is_err());
    authorize(
        &env,
        &admin,
        &id,
        "register_provider",
        (provider.clone(),).into_val(&env),
    );
    assert!(client.try_register_provider(&provider).is_err());
    assert!(client.get_providers().is_empty());
}

#[test]
fn administrative_controls_still_require_admin() {
    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    let admin = Address::generate(&env);
    let provider = Address::generate(&env);
    let asset = Address::generate(&env);
    let id = env.register(FxRouter, (admin.clone(), 900u64));
    let client = FxRouterClient::new(&env, &id);
    let config = AssetConfig {
        enabled: true,
        is_oracle_base: true,
        oracle: Address::generate(&env),
        oracle_asset: OracleAsset::Other(Symbol::new(&env, "USD")),
        oracle_base: Symbol::new(&env, "USD"),
        token_decimals: 7,
    };
    authorize(
        &env,
        &provider,
        &id,
        "set_asset",
        (asset.clone(), config.clone()).into_val(&env),
    );
    assert!(client.try_set_asset(&asset, &config).is_err());
    authorize(&env, &provider, &id, "set_paused", (true,).into_val(&env));
    assert!(client.try_set_paused(&true).is_err());
    authorize(
        &env,
        &provider,
        &id,
        "set_max_price_age",
        (901u64,).into_val(&env),
    );
    assert!(client.try_set_max_price_age(&901).is_err());
    authorize(
        &env,
        &admin,
        &id,
        "set_asset",
        (asset.clone(), config.clone()).into_val(&env),
    );
    client.set_asset(&asset, &config);
    authorize(&env, &admin, &id, "set_paused", (true,).into_val(&env));
    client.set_paused(&true);
    assert!(client.is_paused());
    authorize(
        &env,
        &admin,
        &id,
        "set_max_price_age",
        (901u64,).into_val(&env),
    );
    client.set_max_price_age(&901);
}

#[test]
fn pair_and_liquidity_operations_still_require_provider_auth() {
    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    let admin = Address::generate(&env);
    let provider = Address::generate(&env);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let id = env.register(FxRouter, (admin.clone(), 900u64));
    let client = FxRouterClient::new(&env, &id);
    authorize(
        &env,
        &provider,
        &id,
        "register_provider",
        (provider.clone(),).into_val(&env),
    );
    client.register_provider(&provider);
    let asset_config = AssetConfig {
        enabled: true,
        is_oracle_base: true,
        oracle: Address::generate(&env),
        oracle_asset: OracleAsset::Other(Symbol::new(&env, "USD")),
        oracle_base: Symbol::new(&env, "USD"),
        token_decimals: 7,
    };
    for asset in [&source, &target] {
        authorize(
            &env,
            &admin,
            &id,
            "set_asset",
            (asset.clone(), asset_config.clone()).into_val(&env),
        );
        client.set_asset(asset, &asset_config);
    }
    let pair = PairConfig {
        active: true,
        fee_bps: 30,
        max_amount_in: 50_000_000,
        max_source_inventory: 100_000_000,
    };
    let args = (
        provider.clone(),
        source.clone(),
        target.clone(),
        pair.clone(),
    )
        .into_val(&env);
    authorize(&env, &admin, &id, "set_provider_pair", args);
    assert!(client
        .try_set_provider_pair(&provider, &source, &target, &pair)
        .is_err());
    authorize(
        &env,
        &provider,
        &id,
        "set_provider_pair",
        (
            provider.clone(),
            source.clone(),
            target.clone(),
            pair.clone(),
        )
            .into_val(&env),
    );
    client.set_provider_pair(&provider, &source, &target, &pair);
    assert_eq!(client.get_pair(&provider, &source, &target), Some(pair));
    // Invalid amount deliberately stops before token transfer; distinguish provider
    // authorization success from an unauthorized admin reaching the operation.
    for method in ["deposit", "withdraw"] {
        authorize(
            &env,
            &admin,
            &id,
            method,
            (provider.clone(), source.clone(), 0i128).into_val(&env),
        );
        let rejected = if method == "deposit" {
            client.try_deposit(&provider, &source, &0)
        } else {
            client.try_withdraw(&provider, &source, &0)
        };
        assert!(matches!(rejected, Err(Err(_))));
        authorize(
            &env,
            &provider,
            &id,
            method,
            (provider.clone(), source.clone(), 0i128).into_val(&env),
        );
        let accepted = if method == "deposit" {
            client.try_deposit(&provider, &source, &0)
        } else {
            client.try_withdraw(&provider, &source, &0)
        };
        assert_eq!(accepted, Err(Ok(Error::InvalidAmount)));
    }
}

#[contract]
struct MockOracle;
#[contractimpl]
impl MockOracle {
    pub fn decimals(_env: Env) -> u32 { 7 }
    pub fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData> {
        if env.storage().instance().get::<_,bool>(&symbol_short!("missing")).unwrap_or(false) { return None; }
        let price = match asset {
            OracleAsset::Other(s) if s == Symbol::new(&env, "TRY") => 250_000,
            OracleAsset::Other(s) if s == Symbol::new(&env, "GBP") => 12_500_000,
            _ => 11_000_000,
        };
        let price = env.storage().instance().get::<_,i128>(&symbol_short!("price")).unwrap_or(price);
        Some(PriceData { price, timestamp: 1000 })
    }
}

struct Market {
    env: Env, router: Address, assets: [Address; 4], lps: [Address; 2], sender: Address, recipient: Address,
}
impl Market {
    fn new() -> Self {
        use soroban_sdk::testutils::Ledger;
        let mut env = Env::default();
        env.set_config(soroban_sdk::testutils::EnvTestConfig { capture_snapshot_at_drop: false });
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1000);
        let admin = Address::generate(&env);
        let oracle = env.register(MockOracle, ());
        let router = env.register(FxRouter, (admin.clone(), 900u64));
        let assets = core::array::from_fn(|_| {
            let sac = env.register_stellar_asset_contract_v2(admin.clone());
            sac.issuer().set_flag(soroban_sdk::testutils::IssuerFlags::RevocableFlag);
            sac.address()
        });
        let lps = core::array::from_fn(|_| Address::generate(&env));
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let c = FxRouterClient::new(&env, &router);
        for (i, a) in assets.iter().enumerate() {
            c.set_asset(a, &AssetConfig { enabled: true, is_oracle_base: i==0, oracle: oracle.clone(), oracle_asset: OracleAsset::Other(Symbol::new(&env, ["USD","EUR","TRY","GBP"][i])), oracle_base: Symbol::new(&env,"USD"), token_decimals: 7 });
            token::StellarAssetClient::new(&env,a).mint(&sender,&1_000_000_000_000);
        }
        c.set_hub(&assets[0]);
        for (n, lp) in lps.iter().enumerate() {
            c.register_provider(lp);
            for a in &assets {
                token::StellarAssetClient::new(&env,a).mint(lp,&1_000_000_000_000);
                c.deposit(lp,a,&1_000_000_000_000);
            }
            for i in 1..4 {
                for (s,t) in [(0,i),(i,0)] {
                    c.set_provider_pair(lp,&assets[s],&assets[t],&PairConfig { active:true, fee_bps: if n==0 {20} else {30}, max_amount_in:0, max_source_inventory:0 });
                }
            }
        }
        Self {env,router,assets,lps,sender,recipient}
    }
    fn direct(&self, fee: u32, max: i128) {
        let c=FxRouterClient::new(&self.env,&self.router);
        for (s,t) in [(2,3),(3,2)] {
            c.set_provider_pair(&self.lps[1],&self.assets[s],&self.assets[t],&PairConfig {active:true,fee_bps:fee,max_amount_in:max,max_source_inventory:0});
        }
    }
}
#[test]
fn twelve_directions_net_input_and_same_lp_accounting() {
    let m=Market::new(); let c=FxRouterClient::new(&m.env,&m.router);
    for s in 0..4 { for t in 0..4 { if s==t {continue;}
        let q=c.quote_route(&m.assets[s],&m.assets[t],&100_000_000);
        assert_eq!(q.hops.len(),if s==0 || t==0 {1} else {2});
        if q.hops.len()==2 {assert_eq!(q.hops.get(1).unwrap().amount_in,q.hops.get(0).unwrap().amount_out);}
        assert!(q.amount_out>0);
    }}
    let q=c.quote_route(&m.assets[2],&m.assets[3],&100_000_000);
    let hub_before=c.get_balance(&m.lps[0],&m.assets[0]);
    let source_before=c.get_balance(&m.lps[0],&m.assets[2]);
    let target_before=c.get_balance(&m.lps[0],&m.assets[3]);
    let custody=token::Client::new(&m.env,&m.assets[0]).balance(&m.router);
    c.transfer_route(&m.sender,&m.recipient,&m.assets[2],&m.assets[3],&100_000_000,&q.amount_out,&1100);
    assert_eq!(c.get_balance(&m.lps[0],&m.assets[0]),hub_before);
    assert_eq!(c.get_balance(&m.lps[0],&m.assets[2]),source_before+100_000_000);
    assert_eq!(c.get_balance(&m.lps[0],&m.assets[3]),target_before-q.amount_out);
    assert_eq!(token::Client::new(&m.env,&m.assets[0]).balance(&m.router),custody);
    assert_eq!(token::Client::new(&m.env,&m.assets[3]).balance(&m.recipient),q.amount_out);
    for (i, hop) in q.hops.iter().enumerate() {
        assert_eq!(c.get_fees(&hop.provider,&q.path.get(i as u32+1).unwrap()),hop.fee_amount);
    }
}
#[test]
fn compares_direct_and_two_hop_and_keeps_direct_abi() {
    let m=Market::new(); let c=FxRouterClient::new(&m.env,&m.router);
    m.direct(100,0); assert_eq!(c.quote_route(&m.assets[2],&m.assets[3],&100_000_000).amount_out,1_992_008); assert_eq!(c.quote(&m.assets[2],&m.assets[3],&100_000_000).amount_out,1_980_000); assert_eq!(c.quote_route(&m.assets[2],&m.assets[3],&100_000_000).hops.len(),2);
    m.direct(10,0); assert_eq!(c.quote_route(&m.assets[2],&m.assets[3],&100_000_000).hops.len(),1);
    assert_eq!(c.quote(&m.assets[0],&m.assets[1],&100_000_000),c.quote_route(&m.assets[0],&m.assets[1],&100_000_000).hops.get(0).unwrap());
}
#[test]
fn limits_check_all_first_hop_options_and_adjust_same_lp_inventory() {
    let m=Market::new(); let c=FxRouterClient::new(&m.env,&m.router);
    // Best first hop delivers more than either second-hop input limit; LP-2 still fits.
    for lp in &m.lps {
        c.set_provider_pair(lp,&m.assets[0],&m.assets[3],&PairConfig {active:true,fee_bps:20,max_amount_in:2_493_000,max_source_inventory:1_000_000_000_000});
    }
    let q=c.quote_route(&m.assets[2],&m.assets[3],&100_000_000);
    assert_eq!(q.hops.get(0).unwrap().provider,m.lps[1]);
    assert_eq!(q.hops.get(1).unwrap().provider,m.lps[1]);
    // No hub inventory and no direct support => no route.
    for lp in &m.lps { c.withdraw(lp,&m.assets[0],&1_000_000_000_000); }
    assert_eq!(c.try_quote_route(&m.assets[2],&m.assets[3],&100_000_000),Err(Ok(Error::NoLiquidity)));
}
#[test]
fn route_rejections_and_delivery_failure_roll_back_everything() {
    use soroban_sdk::testutils::Ledger;
    let m=Market::new(); let c=FxRouterClient::new(&m.env,&m.router);
    let q=c.quote_route(&m.assets[2],&m.assets[3],&100_000_000);
    let before=c.get_balance(&m.lps[0],&m.assets[2]);
    let sender_before=token::Client::new(&m.env,&m.assets[2]).balance(&m.sender);
    assert_eq!(c.try_transfer_route(&m.sender,&m.recipient,&m.assets[2],&m.assets[3],&100_000_000,&(q.amount_out+1),&1100),Err(Ok(Error::SlippageExceeded)));
    assert_eq!(c.try_transfer_route(&m.sender,&m.recipient,&m.assets[2],&m.assets[3],&100_000_000,&0,&999),Err(Ok(Error::DeadlineExpired)));
    // SAC rejects delivery to an unauthorized recipient after route accounting.
    token::StellarAssetClient::new(&m.env,&m.assets[3]).set_authorized(&m.recipient,&false);
    assert!(c.try_transfer_route(&m.sender,&m.recipient,&m.assets[2],&m.assets[3],&100_000_000,&0,&1100).is_err());
    assert_eq!(c.get_balance(&m.lps[0],&m.assets[2]),before);
    assert_eq!(c.get_fees(&m.lps[0],&m.assets[0]),0);
    assert_eq!(token::Client::new(&m.env,&m.assets[2]).balance(&m.sender),sender_before);
    m.env.mock_auths(&[]);
    assert!(c.try_transfer_route(&m.sender,&m.recipient,&m.assets[2],&m.assets[3],&100_000_000,&0,&1100).is_err());
    m.env.ledger().with_mut(|l| l.timestamp=2000);
    assert_eq!(c.try_quote_route(&m.assets[2],&m.assets[3],&100_000_000),Err(Ok(Error::OraclePriceStale)));
}

#[test]
fn decimal_conversion_rounds_only_after_rescaling() {
    assert_eq!(calculate_output(1,1,2,1,7),Ok(500_000));
    assert_eq!(calculate_output(100_000_001,3,2,7,2),Ok(1500));
    assert_eq!(calculate_output(i128::MAX,2,1,7,7),Err(Error::MathOverflow));
}
#[test]
fn second_hop_accounting_failure_rolls_back_first_hop() {
    let m=Market::new();let c=FxRouterClient::new(&m.env,&m.router);
    m.env.as_contract(&m.router,||m.env.storage().persistent().set(&DataKey::Fees(m.lps[0].clone(),m.assets[3].clone()),&i128::MAX));
    let before=c.get_balance(&m.lps[0],&m.assets[2]);
    let sender_before=token::Client::new(&m.env,&m.assets[2]).balance(&m.sender);
    assert_eq!(c.try_transfer_route(&m.sender,&m.recipient,&m.assets[2],&m.assets[3],&100_000_000,&0,&1100),Err(Ok(Error::MathOverflow)));
    assert_eq!(c.get_balance(&m.lps[0],&m.assets[2]),before);
    assert_eq!(c.get_fees(&m.lps[0],&m.assets[0]),0);
    assert_eq!(token::Client::new(&m.env,&m.assets[2]).balance(&m.sender),sender_before);
}
#[test]
fn target_inventory_filters_routes_and_equal_output_prefers_direct() {
    let m=Market::new();let c=FxRouterClient::new(&m.env,&m.router);
    m.direct(0,0);
    for lp in &m.lps {
        c.set_provider_pair(lp,&m.assets[2],&m.assets[0],&PairConfig{active:true,fee_bps:0,max_amount_in:0,max_source_inventory:0});
        c.set_provider_pair(lp,&m.assets[0],&m.assets[3],&PairConfig{active:true,fee_bps:0,max_amount_in:0,max_source_inventory:0});
    }
    assert_eq!(c.quote_route(&m.assets[2],&m.assets[3],&100_000_000).hops.len(),1);
    for lp in &m.lps {c.withdraw(lp,&m.assets[3],&1_000_000_000_000);}
    assert_eq!(c.try_quote_route(&m.assets[2],&m.assets[3],&100_000_000),Err(Ok(Error::NoLiquidity)));
}

#[test]
fn missing_oracle_blocks_quote_without_demo_fallback() {
    let m=Market::new();let c=FxRouterClient::new(&m.env,&m.router);
    let oracle=c.get_asset(&m.assets[3]).unwrap().oracle;
    m.env.as_contract(&oracle,||m.env.storage().instance().set(&symbol_short!("missing"),&true));
    assert_eq!(c.try_quote_route(&m.assets[2],&m.assets[3],&100_000_000),Err(Ok(Error::OraclePriceMissing)));
}

#[test]
fn two_different_lps_exchange_hub_inventory_without_moving_hub_custody() {
    let m=Market::new(); let c=FxRouterClient::new(&m.env,&m.router);
    c.set_provider_pair(&m.lps[0],&m.assets[0],&m.assets[3],&PairConfig {active:false,fee_bps:20,max_amount_in:0,max_source_inventory:0});
    let input=200_000_000;
    let q=c.quote_route(&m.assets[2],&m.assets[3],&input);
    let first=q.hops.get(0).unwrap(); let second=q.hops.get(1).unwrap();
    assert_eq!(first.provider,m.lps[0]); assert_eq!(second.provider,m.lps[1]);
    assert_eq!(first.amount_out,second.amount_in);
    let hub0=c.get_balance(&m.lps[0],&m.assets[0]);
    let hub1=c.get_balance(&m.lps[1],&m.assets[0]);
    let source=c.get_balance(&m.lps[0],&m.assets[2]);
    let target=c.get_balance(&m.lps[1],&m.assets[3]);
    let sender=token::Client::new(&m.env,&m.assets[2]).balance(&m.sender);
    let custody=token::Client::new(&m.env,&m.assets[0]).balance(&m.router);
    let actual=c.transfer_route(&m.sender,&m.recipient,&m.assets[2],&m.assets[3],&input,&q.amount_out,&1100);
    assert_eq!(actual,q);
    assert_eq!(c.get_balance(&m.lps[0],&m.assets[2]),source+input);
    assert_eq!(c.get_balance(&m.lps[0],&m.assets[0]),hub0-first.amount_out);
    assert_eq!(c.get_balance(&m.lps[1],&m.assets[0]),hub1+second.amount_in);
    assert_eq!(c.get_balance(&m.lps[1],&m.assets[3]),target-second.amount_out);
    assert_eq!(c.get_fees(&m.lps[0],&m.assets[0]),first.fee_amount);
    assert_eq!(c.get_fees(&m.lps[1],&m.assets[3]),second.fee_amount);
    assert_eq!(c.get_fees(&m.lps[0],&m.assets[3]),0);
    assert_eq!(c.get_fees(&m.lps[1],&m.assets[0]),0);
    assert_eq!(token::Client::new(&m.env,&m.assets[0]).balance(&m.router),custody);
    assert_eq!(token::Client::new(&m.env,&m.assets[2]).balance(&m.sender),sender-input);
    assert_eq!(token::Client::new(&m.env,&m.assets[3]).balance(&m.recipient),q.amount_out);
}

/// The real TRY demo oracle keeps TRY routable for its demo TTL without keeper pushes,
/// while Reflector-style feeds keep the router's unchanged 900-second limit.
#[test]
fn demo_try_feed_outlives_the_keeper_but_not_its_ttl_while_reflector_stays_strict() {
    use soroban_sdk::testutils::Ledger;
    let m=Market::new(); let c=FxRouterClient::new(&m.env,&m.router);
    m.env.ledger().with_mut(|l| l.network_id=m.env.crypto().sha256(&soroban_sdk::Bytes::from_slice(&m.env,b"Test SDF Network ; September 2015")).to_array());
    let day=86_400u64;
    let demo=m.env.register(demo_oracle::DemoOracle,(Address::generate(&m.env),day));
    demo_oracle::DemoOracleClient::new(&m.env,&demo).set_price(&demo_oracle::PriceData{price:2_000_000_000_000,timestamp:1000},&(1000+day));
    c.set_asset(&m.assets[2],&AssetConfig{enabled:true,is_oracle_base:false,oracle:demo,oracle_asset:OracleAsset::Other(Symbol::new(&m.env,"TRY")),oracle_base:Symbol::new(&m.env,"USD"),token_decimals:7});
    // Six hours with no keeper refresh.
    m.env.ledger().with_mut(|l| l.timestamp=1000+6*3600);
    assert_eq!(c.quote_route(&m.assets[2],&m.assets[0],&100_000_000).hops.get(0).unwrap().source_oracle_timestamp,1000+6*3600);
    assert_eq!(c.get_max_price_age(),900);
    assert_eq!(c.try_quote_route(&m.assets[3],&m.assets[0],&100_000_000),Err(Ok(Error::OraclePriceStale)));
    assert_eq!(c.try_quote_route(&m.assets[2],&m.assets[3],&100_000_000),Err(Ok(Error::OraclePriceStale)));
    m.env.ledger().with_mut(|l| l.timestamp=1000+day+1);
    assert_eq!(c.try_quote_route(&m.assets[2],&m.assets[0],&100_000_000),Err(Ok(Error::OraclePriceMissing)));
}

#[test]
fn deposit_and_withdraw_move_wallet_router_and_recorded_inventory_together() {
    let m=Market::new(); let c=FxRouterClient::new(&m.env,&m.router);
    let lp=Address::generate(&m.env); c.register_provider(&lp);
    for a in &m.assets {
        let t=token::Client::new(&m.env,a);
        token::StellarAssetClient::new(&m.env,a).mint(&lp,&100_000_000);
        let (router0,other0)=(t.balance(&m.router),c.get_balance(&m.lps[0],a));
        assert_eq!(c.get_balance(&lp,a),0);
        // 5 units in: wallet 10 -> 5, router +5, recorded inventory 0 -> 5 (also the return value).
        assert_eq!(c.deposit(&lp,a,&50_000_000),50_000_000);
        assert_eq!((t.balance(&lp),t.balance(&m.router),c.get_balance(&lp,a)),(50_000_000,router0+50_000_000,50_000_000));
        // More than the wallet holds fails inside the token transfer and changes nothing.
        assert!(c.try_deposit(&lp,a,&50_000_001).is_err());
        assert_eq!((t.balance(&lp),c.get_balance(&lp,a)),(50_000_000,50_000_000));
        assert_eq!(c.withdraw(&lp,a,&20_000_000),30_000_000);
        assert_eq!((t.balance(&lp),t.balance(&m.router),c.get_balance(&lp,a)),(70_000_000,router0+30_000_000,30_000_000));
        assert_eq!(c.try_withdraw(&lp,a,&30_000_001),Err(Ok(Error::InsufficientBalance)));
        assert_eq!(c.get_balance(&m.lps[0],a),other0);
    }
}

#[test]
fn retained_fee_funds_the_next_swap_without_double_credit_or_extra_withdrawal_rights() {
    // Cover both the legacy direct entry point and the active single-hop route entry point.
    for routed in [false, true] {
        let m=Market::new(); let c=FxRouterClient::new(&m.env,&m.router);
        let (lp,source,target)=(&m.lps[0],&m.assets[0],&m.assets[1]);
        let mut config=c.get_asset(target).unwrap();
        config.is_oracle_base=true; // Exact 1:1 prices make the expected integer amounts explicit.
        c.set_asset(target,&config);
        c.withdraw(&m.lps[1],target,&1_000_000_000_000);
        c.withdraw(lp,target,&999_990_000_000); // Only one token remains in all router target inventory.
        let source_before=c.get_balance(lp,source);
        let execute=|amount:i128,minimum:i128| {
            if routed {
                c.transfer_route(&m.sender,&m.recipient,source,target,&amount,&minimum,&1100).amount_out
            } else {
                c.transfer_with_swap(&m.sender,&m.recipient,source,target,&amount,&minimum,&1100).amount_out
            }
        };
        assert_eq!(execute(10_000_000,9_980_000),9_980_000);
        assert_eq!(c.get_fees(lp,target),20_000);
        assert_eq!(c.get_fees(&m.lps[1],target),0);
        assert_eq!(c.get_fees(lp,source),0);
        assert_eq!(c.get_balance(lp,target),20_000); // Not 40_000: the fee is already retained.
        assert_eq!(token::Client::new(&m.env,target).balance(&m.router),20_000);
        // The fee remainder is the ONLY target liquidity available for this second execution.
        assert_eq!(execute(20_000,19_960),19_960);
        assert_eq!(c.get_balance(lp,source),source_before+10_020_000);
        assert_eq!(c.get_balance(lp,target),40);
        assert_eq!(c.get_fees(lp,target),20_040);
        assert_eq!(token::Client::new(&m.env,target).balance(&m.recipient),9_999_960);
        assert_eq!(token::Client::new(&m.env,target).balance(&m.router),40);
        assert_eq!(c.try_withdraw(lp,target,&20_080),Err(Ok(Error::InsufficientBalance)));
        let wallet_before=token::Client::new(&m.env,target).balance(lp);
        assert_eq!(c.withdraw(lp,target,&40),0);
        assert_eq!(token::Client::new(&m.env,target).balance(lp),wallet_before+40);
        assert_eq!(c.get_fees(lp,target),20_040);
        assert_eq!(c.try_withdraw(lp,target,&1),Err(Ok(Error::InsufficientBalance)));
        // A later LP deposit does not inherit or dilute the earlier LP's earned fee record.
        c.deposit(&m.lps[1],target,&100);
        assert_eq!(c.get_balance(&m.lps[1],target),100);
        assert_eq!(c.get_balance(lp,target),0);
        assert_eq!(c.get_fees(&m.lps[1],target),0);
        assert_eq!(c.get_fees(lp,target),20_040);
    }
}

#[test]
fn deposits_withdrawals_quotes_and_price_changes_do_not_accrue_fees() {
    let m=Market::new(); let c=FxRouterClient::new(&m.env,&m.router);
    let (lp,source,target)=(&m.lps[0],&m.assets[0],&m.assets[1]);
    let q=c.transfer_route(&m.sender,&m.recipient,source,target,&10_000_000,&1,&1100);
    let fee=q.hops.get(0).unwrap().fee_amount;
    assert!(fee>0);
    c.withdraw(lp,target,&100);
    assert_eq!(c.get_fees(lp,target),fee);
    c.deposit(lp,target,&100);
    assert_eq!(c.get_fees(lp,target),fee);
    let before=c.quote_route(source,target,&10_000_000);
    assert_eq!(c.get_fees(lp,target),fee);
    let oracle=c.get_asset(target).unwrap().oracle;
    m.env.as_contract(&oracle,||m.env.storage().instance().set(&symbol_short!("price"),&22_000_000i128));
    assert_eq!(c.get_fees(lp,target),fee);
    let after=c.quote_route(source,target,&10_000_000);
    assert!(after.amount_out<before.amount_out);
    assert_eq!(c.get_fees(lp,target),fee);
    assert_eq!(c.get_fees(lp,source),0);
    assert_eq!(c.get_fees(&m.lps[1],target),0);
}

#[test]
fn another_lp_cannot_authorize_a_positive_withdrawal_from_the_owner() {
    let m=Market::new(); let c=FxRouterClient::new(&m.env,&m.router);
    let (owner,attacker,asset)=(&m.lps[0],&m.lps[1],&m.assets[1]);
    let t=token::Client::new(&m.env,asset);
    let before=(c.get_balance(owner,asset),c.get_balance(attacker,asset),t.balance(&m.router),t.balance(owner),t.balance(attacker));
    // Replace mock_all_auths with exactly the attacker's authorization for the victim's arguments.
    authorize(&m.env,attacker,&m.router,"withdraw",(owner.clone(),asset.clone(),1i128).into_val(&m.env));
    assert!(matches!(c.try_withdraw(owner,asset,&1),Err(Err(_))));
    assert_eq!((c.get_balance(owner,asset),c.get_balance(attacker,asset),t.balance(&m.router),t.balance(owner),t.balance(attacker)),before);
    // The same positive operation succeeds only when the owner authorizes it.
    authorize(&m.env,owner,&m.router,"withdraw",(owner.clone(),asset.clone(),1i128).into_val(&m.env));
    assert_eq!(c.withdraw(owner,asset,&1),before.0-1);
    assert_eq!(t.balance(owner),before.3+1);
    assert_eq!(c.get_balance(attacker,asset),before.1);
}
