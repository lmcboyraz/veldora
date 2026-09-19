#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String,
};

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Name,
    Symbol,
    Decimals,
    Balance(Address),
    Claimed(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    InsufficientBalance = 2,
    MathOverflow = 3,
    FaucetAlreadyClaimed = 4,
}

#[contract]
pub struct DemoToken;

#[contractimpl]
impl DemoToken {
    pub fn __constructor(
        env: Env,
        admin: Address,
        name: String,
        symbol: String,
        decimals: u32,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
    }

    pub fn mint(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        add_balance(&env, &to, amount)?;
        env.events().publish((symbol_short!("mint"), to), amount);
        Ok(())
    }

    pub fn faucet(env: Env, to: Address) -> Result<i128, Error> {
        to.require_auth();
        let claimed_key = DataKey::Claimed(to.clone());
        if env
            .storage()
            .persistent()
            .get::<_, bool>(&claimed_key)
            .unwrap_or(false)
        {
            return Err(Error::FaucetAlreadyClaimed);
        }

        let decimals: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Decimals)
            .unwrap();
        let amount = 10_000_i128
            .checked_mul(pow10(decimals)?)
            .ok_or(Error::MathOverflow)?;
        env.storage().persistent().set(&claimed_key, &true);
        add_balance(&env, &to, amount)?;
        env.events()
            .publish((symbol_short!("faucet"), to), amount);
        Ok(amount)
    }

    pub fn transfer(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let from_balance = balance(&env, &from);
        if from_balance < amount {
            return Err(Error::InsufficientBalance);
        }
        set_balance(
            &env,
            &from,
            from_balance
                .checked_sub(amount)
                .ok_or(Error::MathOverflow)?,
        );
        add_balance(&env, &to, amount)?;
        env.events()
            .publish((symbol_short!("transfer"), from, to), amount);
        Ok(())
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        balance(&env, &id)
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Decimals)
            .unwrap()
    }

    pub fn name(env: Env) -> String {
        env.storage().instance().get(&DataKey::Name).unwrap()
    }

    pub fn symbol(env: Env) -> String {
        env.storage().instance().get(&DataKey::Symbol).unwrap()
    }
}

fn balance(env: &Env, id: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(id.clone()))
        .unwrap_or(0)
}

fn set_balance(env: &Env, id: &Address, amount: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::Balance(id.clone()), &amount);
}

fn add_balance(env: &Env, id: &Address, amount: i128) -> Result<i128, Error> {
    let next = balance(env, id)
        .checked_add(amount)
        .ok_or(Error::MathOverflow)?;
    set_balance(env, id, next);
    Ok(next)
}

fn pow10(exponent: u32) -> Result<i128, Error> {
    let mut result = 1_i128;
    for _ in 0..exponent {
        result = result.checked_mul(10).ok_or(Error::MathOverflow)?;
    }
    Ok(result)
}
