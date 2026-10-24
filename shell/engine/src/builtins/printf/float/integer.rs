use super::super::{PrintFailure, Printer};
use std::cmp::Ordering;

#[derive(Clone)]
pub(super) struct Integer(Vec<u32>);

impl Integer {
    pub fn new(value: u64) -> Self {
        let mut result = Self(vec![value as u32, (value >> 32) as u32]);
        result.trim();
        result
    }

    pub fn bits(&self) -> i32 {
        self.0.last().map_or(0, |last| {
            (self.0.len() as i32 - 1) * 32 + 32 - last.leading_zeros() as i32
        })
    }

    fn trim(&mut self) {
        while self.0.last() == Some(&0) {
            self.0.pop();
        }
    }

    pub fn compare(&self, other: &Self) -> Ordering {
        self.0
            .len()
            .cmp(&other.0.len())
            .then_with(|| self.0.iter().rev().cmp(other.0.iter().rev()))
    }

    pub async fn multiply(
        &mut self,
        factor: u32,
        add: u32,
        printer: &mut Printer<'_>,
    ) -> Result<(), PrintFailure> {
        printer.scan(self.0.len().max(1)).await?;
        let mut carry = u64::from(add);
        for word in &mut self.0 {
            carry += u64::from(*word) * u64::from(factor);
            *word = carry as u32;
            carry >>= 32;
        }
        if carry != 0 {
            self.0.push(carry as u32);
        }
        Ok(())
    }

    pub async fn power(
        &mut self,
        base: u32,
        exponent: usize,
        printer: &mut Printer<'_>,
    ) -> Result<(), PrintFailure> {
        let group = if base == 5 { 13 } else { 9 };
        for _ in 0..exponent / group {
            self.multiply(base.pow(group as u32), 0, printer).await?;
        }
        self.multiply(base.pow((exponent % group) as u32), 0, printer)
            .await
    }

    pub fn shift(&mut self, bits: usize) {
        if self.0.is_empty() || bits == 0 {
            return;
        }
        let words = bits / 32;
        let bits = bits % 32;
        let length = self.0.len();
        self.0.resize(length + words + 1, 0);
        self.0.copy_within(..length, words);
        self.0[..words].fill(0);
        let mut carry = 0u64;
        for word in &mut self.0[words..] {
            let value = (u64::from(*word) << bits) | carry;
            *word = value as u32;
            carry = value >> 32;
        }
        self.trim();
    }

    fn half(&mut self) {
        let mut carry = 0;
        for word in self.0.iter_mut().rev() {
            let next = *word << 31;
            *word = (*word >> 1) | carry;
            carry = next;
        }
        self.trim();
    }

    fn subtract(&mut self, other: &Self) {
        let mut borrow = 0u64;
        for (index, word) in self.0.iter_mut().enumerate() {
            let subtrahend = u64::from(other.0.get(index).copied().unwrap_or(0)) + borrow;
            let value = u64::from(*word).wrapping_sub(subtrahend);
            *word = value as u32;
            borrow = value >> 63;
        }
        self.trim();
    }

    pub async fn quotient(
        &mut self,
        denominator: &Self,
        printer: &mut Printer<'_>,
    ) -> Result<u64, PrintFailure> {
        let mut divisor = denominator.clone();
        divisor.shift(63);
        let mut quotient = 0;
        for bit in (0..64).rev() {
            printer.scan(self.0.len() + divisor.0.len()).await?;
            if self.compare(&divisor) != Ordering::Less {
                self.subtract(&divisor);
                quotient |= 1u64 << bit;
            }
            divisor.half();
        }
        Ok(quotient)
    }

    fn divide_small(&mut self, divisor: u32) -> u32 {
        let mut remainder = 0u64;
        for word in self.0.iter_mut().rev() {
            let value = (remainder << 32) | u64::from(*word);
            *word = (value / u64::from(divisor)) as u32;
            remainder = value % u64::from(divisor);
        }
        self.trim();
        remainder as u32
    }

    pub async fn decimal(mut self, printer: &mut Printer<'_>) -> Result<Vec<u8>, PrintFailure> {
        let mut chunks = Vec::new();
        while !self.0.is_empty() {
            printer.scan(self.0.len()).await?;
            chunks.push(self.divide_small(1_000_000_000));
        }
        let mut digits = chunks.pop().unwrap_or(0).to_string();
        for chunk in chunks.iter().rev() {
            use std::fmt::Write;
            write!(digits, "{chunk:09}").expect("writing to String");
        }
        Ok(digits.into_bytes())
    }
}
