#![no_std]
//! TRY-only demo/mock price feed for Stellar Testnet. Reflector's testnet FX feed has no TRY,
//! so an admin (the Veldora keeper) pushes snapshots. Each snapshot is served as the current
//! price until it expires, at most `max_ttl` seconds after it was set, so TRY keeps routing
//! when the keeper stops. The router's strict freshness limit for real Reflector feeds is
//! untouched; `snapshot` exposes when this demo price was really set.
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol, Vec};
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OracleAsset { Stellar(Address), Other(Symbol) }
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData { pub price: i128, pub timestamp: u64 }
/// The latest demo snapshot: when it was set and when it stops being served.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Snapshot { pub price: i128, pub timestamp: u64, pub expires: u64 }
#[contract]
pub struct DemoOracle;
#[contracttype]
#[derive(Clone)]
enum Key { Admin, Price, Expires, MaxTtl }
/// Ceiling for the configurable demo TTL, so the mock feed can never become a permanent price.
const MAX_TTL_CEILING: u64 = 7 * 24 * 60 * 60;
/// Keep the instance alive (in ledgers, ~5 s each) while the keeper is pushing snapshots.
const INSTANCE_TTL_THRESHOLD: u32 = 7 * 17_280;
const INSTANCE_TTL_EXTEND: u32 = 30 * 17_280;
fn testnet(env: &Env) {
    let expected = env.crypto().sha256(&soroban_sdk::Bytes::from_slice(env, b"Test SDF Network ; September 2015"));
    assert!(env.ledger().network_id() == expected.to_bytes(), "Demo oracle is testnet only");
}
fn valid_ttl(max_ttl: u64) {
    assert!(max_ttl > 0 && max_ttl <= MAX_TTL_CEILING, "Invalid TTL");
}
fn admin(env: &Env) -> Address { env.storage().instance().get(&Key::Admin).unwrap() }
fn max_ttl(env: &Env) -> u64 { env.storage().instance().get(&Key::MaxTtl).unwrap() }
fn current(env: &Env) -> Option<Snapshot> {
    let data = env.storage().instance().get::<_, PriceData>(&Key::Price)?;
    // A lowered TTL also shortens the snapshot that is already live.
    let expires = env.storage().instance().get::<_, u64>(&Key::Expires).unwrap_or(0)
        .min(data.timestamp.saturating_add(max_ttl(env)));
    if env.ledger().timestamp() > expires { return None; }
    Some(Snapshot { price: data.price, timestamp: data.timestamp, expires })
}
#[contractimpl]
impl DemoOracle {
    pub fn __constructor(env: Env, admin: Address, max_ttl: u64) {
        testnet(&env);
        valid_ttl(max_ttl);
        env.storage().instance().set(&Key::Admin, &admin);
        env.storage().instance().set(&Key::MaxTtl, &max_ttl);
    }
    /// Testnet/demo freshness: the longest time one snapshot may be served.
    pub fn set_max_ttl(env: Env, max_ttl: u64) {
        testnet(&env);
        admin(&env).require_auth();
        valid_ttl(max_ttl);
        env.storage().instance().set(&Key::MaxTtl, &max_ttl);
    }
    pub fn max_ttl(env: Env) -> u64 { max_ttl(&env) }
    pub fn set_price(env: Env, data: PriceData, expires: u64) {
        testnet(&env);
        admin(&env).require_auth();
        let now=env.ledger().timestamp();
        assert!(data.price>0 && data.timestamp<=now && expires>now && expires>data.timestamp && expires-data.timestamp<=max_ttl(&env), "Invalid snapshot");
        env.storage().instance().set(&Key::Price,&data);
        env.storage().instance().set(&Key::Expires,&expires);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }
    pub fn decimals(_env: Env) -> u32 {14}
    pub fn base(env: Env) -> OracleAsset { OracleAsset::Other(Symbol::new(&env,"USD")) }
    pub fn assets(env: Env) -> Vec<OracleAsset> { soroban_sdk::vec![&env,OracleAsset::Other(Symbol::new(&env,"TRY"))] }
    /// Mock feed: reports the read time while the snapshot is live (see the module docs).
    pub fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData> {
        testnet(&env);
        if asset!=OracleAsset::Other(Symbol::new(&env,"TRY")) {return None;}
        current(&env).map(|s| PriceData { price: s.price, timestamp: env.ledger().timestamp() })
    }
    pub fn snapshot(env: Env) -> Option<Snapshot> {
        testnet(&env);
        current(&env)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    const DAY: u64 = 86_400;
    fn setup() -> (Env, Address) {
        let mut env=Env::default();
        env.set_config(soroban_sdk::testutils::EnvTestConfig {capture_snapshot_at_drop:false});
        env.ledger().with_mut(|l| { l.timestamp=1000; l.network_id=env.crypto().sha256(&soroban_sdk::Bytes::from_slice(&env,b"Test SDF Network ; September 2015")).to_array(); });
        let admin=Address::generate(&env);
        let id=env.register(DemoOracle,(admin,DAY));
        (env,id)
    }
    fn asset(env: &Env, symbol: &str) -> OracleAsset { OracleAsset::Other(Symbol::new(env,symbol)) }
    #[test]
    fn snapshot_is_served_until_the_demo_ttl_even_without_refreshes() {
        let (env,id)=setup(); env.mock_all_auths(); let c=DemoOracleClient::new(&env,&id);
        let price=2_057_717_621_180;
        c.set_price(&PriceData{price,timestamp:1000},&(1000+DAY));
        // Six hours after the last keeper push, far past the router's 15-minute Reflector limit.
        env.ledger().with_mut(|l|l.timestamp=1000+6*3600);
        assert_eq!(c.lastprice(&asset(&env,"TRY")),Some(PriceData{price,timestamp:1000+6*3600}));
        assert_eq!(c.snapshot(),Some(Snapshot{price,timestamp:1000,expires:1000+DAY}));
        assert_eq!(c.lastprice(&asset(&env,"GBP")),None);
        env.ledger().with_mut(|l|l.timestamp=1000+DAY);
        assert!(c.lastprice(&asset(&env,"TRY")).is_some());
        env.ledger().with_mut(|l|l.timestamp=1000+DAY+1);
        assert_eq!(c.lastprice(&asset(&env,"TRY")),None);
        assert_eq!(c.snapshot(),None);
    }
    #[test]
    fn ttl_is_configurable_bounded_and_admin_only() {
        let (env,id)=setup(); let c=DemoOracleClient::new(&env,&id);
        let data=PriceData{price:1,timestamp:1000};
        assert!(c.try_set_price(&data,&(1000+DAY)).is_err());
        assert!(c.try_set_max_ttl(&900).is_err());
        env.mock_all_auths();
        assert_eq!(c.max_ttl(),DAY);
        assert!(c.try_set_price(&data,&(1000+DAY+1)).is_err());
        c.set_price(&data,&(1000+DAY));
        // Shortening the TTL applies to the live snapshot immediately.
        c.set_max_ttl(&900);
        assert_eq!(c.snapshot().unwrap().expires,1900);
        env.ledger().with_mut(|l|l.timestamp=1901);
        assert_eq!(c.lastprice(&asset(&env,"TRY")),None);
        assert!(c.try_set_max_ttl(&0).is_err());
        assert!(c.try_set_max_ttl(&(7*DAY+1)).is_err());
    }
    #[test]
    fn invalid_snapshots_and_mainnet_are_rejected() {
        let (env,id)=setup(); env.mock_all_auths(); let c=DemoOracleClient::new(&env,&id);
        assert!(c.try_set_price(&PriceData{price:0,timestamp:1000},&1900).is_err());
        assert!(c.try_set_price(&PriceData{price:1,timestamp:1001},&1900).is_err());
        assert!(c.try_set_price(&PriceData{price:1,timestamp:1000},&1000).is_err());
        let data=PriceData{price:1,timestamp:1000};
        env.ledger().with_mut(|l|l.network_id=[0;32]);
        assert!(c.try_set_price(&data,&1900).is_err());
        assert!(c.try_lastprice(&asset(&env,"TRY")).is_err());
    }
    #[test]
    #[should_panic(expected = "Invalid TTL")]
    fn constructor_rejects_unbounded_ttl() {
        let mut env=Env::default();
        env.set_config(soroban_sdk::testutils::EnvTestConfig {capture_snapshot_at_drop:false});
        env.ledger().with_mut(|l| l.network_id=env.crypto().sha256(&soroban_sdk::Bytes::from_slice(&env,b"Test SDF Network ; September 2015")).to_array());
        env.register(DemoOracle,(Address::generate(&env),8*DAY));
    }
}
