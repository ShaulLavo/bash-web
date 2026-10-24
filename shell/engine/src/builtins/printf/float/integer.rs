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

    /// Callers keep the quotient below 2^64. Work is charged per quotient word,
    /// proportional to the divisor length, before the synchronous division.
    pub async fn quotient(
        &mut self,
        denominator: &Self,
        printer: &mut Printer<'_>,
    ) -> Result<u64, PrintFailure> {
        let words = self.0.len().saturating_sub(denominator.0.len()) + 1;
        printer.scan(words * (denominator.0.len() + 1)).await?;
        Ok(self.divide(denominator))
    }

    /// Word-wise long division (Knuth, TAOCP 4.3.1 algorithm D) leaving the
    /// remainder in `self`. Returns the low 64 quotient bits.
    fn divide(&mut self, denominator: &Self) -> u64 {
        if self.compare(denominator) == Ordering::Less {
            return 0;
        }
        if denominator.0.len() == 1 {
            return self.divide_word(denominator.0[0]);
        }
        let shift = denominator.0.last().map_or(0, |last| last.leading_zeros()) as usize;
        let mut divisor = denominator.clone();
        divisor.shift(shift);
        let mut dividend = self.0.clone();
        dividend.push(0);
        let mut shifted = Self(dividend);
        shifted.shift_words_in_place(shift);
        let length = divisor.0.len();
        let mut quotient = 0u64;
        for index in (0..shifted.0.len() - length).rev() {
            let digit = divide_step(&mut shifted.0[index..=index + length], &divisor.0);
            quotient = quotient.wrapping_shl(32) | u64::from(digit);
        }
        shifted.0.truncate(length);
        shifted.trim();
        shifted.unshift(shift);
        *self = shifted;
        quotient
    }

    /// Left shift that keeps the existing word count (the caller reserved the top word).
    fn shift_words_in_place(&mut self, bits: usize) {
        if bits == 0 {
            return;
        }
        let mut carry = 0u32;
        for word in &mut self.0 {
            let next = *word >> (32 - bits);
            *word = (*word << bits) | carry;
            carry = next;
        }
    }

    fn unshift(&mut self, bits: usize) {
        if bits == 0 {
            return;
        }
        let mut carry = 0u32;
        for word in self.0.iter_mut().rev() {
            let next = *word << (32 - bits);
            *word = (*word >> bits) | carry;
            carry = next;
        }
        self.trim();
    }

    /// Single-word divisor: low 64 quotient bits, remainder left in `self`.
    fn divide_word(&mut self, divisor: u32) -> u64 {
        let mut quotient = 0u64;
        let mut remainder = 0u64;
        for word in self.0.iter().rev() {
            let value = (remainder << 32) | u64::from(*word);
            quotient = quotient.wrapping_shl(32) | (value / u64::from(divisor));
            remainder = value % u64::from(divisor);
        }
        *self = Self::new(remainder);
        quotient
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

/// One algorithm D step: `window` holds divisor-length + 1 dividend words
/// (normalized divisor), replaced by the partial remainder.
fn divide_step(window: &mut [u32], divisor: &[u32]) -> u32 {
    const BASE: u64 = 1 << 32;
    let length = divisor.len();
    let top = (u64::from(window[length]) << 32) | u64::from(window[length - 1]);
    let leading = u64::from(divisor[length - 1]);
    let mut estimate = top / leading;
    let mut remainder = top % leading;
    while remainder < BASE
        && (estimate >= BASE
            || estimate * u64::from(divisor[length - 2])
                > (remainder << 32) | u64::from(window[length - 2]))
    {
        estimate -= 1;
        remainder += leading;
    }
    let mut borrow = 0i64;
    let mut carry = 0u64;
    for (word, digit) in window.iter_mut().zip(divisor) {
        let product = estimate * u64::from(*digit) + carry;
        carry = product >> 32;
        let value = i64::from(*word) - (product & 0xffff_ffff) as i64 + borrow;
        *word = value as u32;
        borrow = value >> 32;
    }
    let value = i64::from(window[length]) - carry as i64 + borrow;
    window[length] = value as u32;
    if value >= 0 {
        return estimate as u32;
    }
    let mut carry = 0u64;
    for (word, digit) in window.iter_mut().zip(divisor) {
        let sum = u64::from(*word) + u64::from(*digit) + carry;
        *word = sum as u32;
        carry = sum >> 32;
    }
    window[length] = window[length].wrapping_add(carry as u32);
    (estimate - 1) as u32
}

#[cfg(test)]
mod tests {
    use super::Integer;
    use std::cmp::Ordering;

    /// The replaced bit-serial division, kept as the reference.
    fn reference(numerator: &mut Integer, denominator: &Integer) -> u64 {
        let mut quotient = 0u64;
        for bit in (0..64).rev() {
            let mut divisor = denominator.clone();
            divisor.shift(bit);
            if numerator.compare(&divisor) == Ordering::Less {
                continue;
            }
            let mut borrow = 0u64;
            for (index, word) in numerator.0.iter_mut().enumerate() {
                let subtrahend = u64::from(divisor.0.get(index).copied().unwrap_or(0)) + borrow;
                let value = u64::from(*word).wrapping_sub(subtrahend);
                *word = value as u32;
                borrow = value >> 63;
            }
            numerator.trim();
            quotient |= 1 << bit;
        }
        quotient
    }

    fn random(state: &mut u64, words: usize) -> Integer {
        let mut value = Integer(
            (0..words)
                .map(|_| {
                    *state = state
                        .wrapping_mul(6_364_136_223_846_793_005)
                        .wrapping_add(1);
                    (*state >> 32) as u32
                })
                .collect(),
        );
        value.trim();
        value
    }

    #[test]
    fn word_division_handles_add_back_vectors() {
        // Hacker's Delight divmnu vectors that need the rare add-back correction.
        for (numerator, denominator) in [
            (vec![3, 0, 0x8000_0000], vec![1, 0, 0x2000_0000]),
            (
                vec![0, 0, 0x8000_0000, 0x7fff_ffff],
                vec![1, 0, 0x8000_0000],
            ),
            (vec![0, 0xfffe, 0, 0x8000], vec![0xffff, 0x8000]),
        ] {
            let denominator = Integer(denominator);
            let mut expected = Integer(numerator);
            expected.trim();
            let mut actual = expected.clone();
            let want = reference(&mut expected, &denominator);
            assert_eq!(actual.divide(&denominator), want);
            assert_eq!(actual.0, expected.0);
        }
    }

    #[test]
    fn word_division_matches_bit_serial_reference() {
        let mut state = 7;
        for case in 0..20_000 {
            let mut denominator = random(&mut state, 1 + case % 6);
            if denominator.bits() == 0 {
                denominator = Integer::new(1);
            }
            let mut quotient = random(&mut state, 3);
            quotient.0.truncate(2);
            quotient.trim();
            let mut numerator = denominator.clone();
            let mut product = Integer(vec![0; numerator.0.len() + 2]);
            for (i, a) in quotient.0.iter().enumerate() {
                let mut carry = 0u64;
                for (j, b) in numerator.0.iter().enumerate() {
                    let sum = u64::from(product.0[i + j]) + u64::from(*a) * u64::from(*b) + carry;
                    product.0[i + j] = sum as u32;
                    carry = sum >> 32;
                }
                product.0[i + numerator.0.len()] = carry as u32;
            }
            let remainder = random(&mut state, denominator.0.len());
            numerator = product;
            let mut carry = 0u64;
            for (index, word) in numerator.0.iter_mut().enumerate() {
                let sum = u64::from(*word)
                    + u64::from(remainder.0.get(index).copied().unwrap_or(0))
                    + carry;
                *word = sum as u32;
                carry = sum >> 32;
            }
            numerator.trim();
            let mut expected = numerator.clone();
            let mut actual = numerator.clone();
            let want = reference(&mut expected, &denominator);
            if expected.compare(&denominator) != Ordering::Less {
                continue;
            }
            assert_eq!(actual.divide(&denominator), want, "case {case}");
            assert_eq!(actual.0, expected.0, "case {case}");
        }
    }
}
