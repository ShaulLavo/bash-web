use super::super::{PrintFailure, Printer};
use super::integer::Integer;
use std::{cmp::Ordering, fmt::Write};

pub(super) struct Decimal {
    pub digits: Vec<u8>,
    pub point: i32,
}

impl Decimal {
    pub async fn new(
        significand: u64,
        exponent: i32,
        conversion: u8,
        precision: Option<usize>,
        printer: &mut Printer<'_>,
    ) -> Result<Self, PrintFailure> {
        if significand == 0 {
            return Ok(Self {
                digits: vec![b'0'],
                point: 1,
            });
        }
        let point = ((significand as f64).log10() + f64::from(exponent) * std::f64::consts::LOG10_2)
            .floor() as i32
            + 1;
        let precision = precision.unwrap_or(6);
        let keep = match conversion.to_ascii_lowercase() {
            b'f' => i64::from(point) + precision as i64,
            b'e' => precision as i64 + 1,
            _ => precision.max(1) as i64,
        };
        // The logarithm only chooses an algorithm. Exact integer comparisons decide rounding.
        if keep < -1 {
            return Ok(Self {
                digits: vec![b'0'],
                point: 1,
            });
        }
        if keep <= 36 {
            return Self::prefix(
                significand,
                exponent,
                point,
                keep.max(0) as usize + 2,
                printer,
            )
            .await;
        }
        Self::exact(significand, exponent, printer).await
    }

    async fn prefix(
        significand: u64,
        exponent: i32,
        mut point: i32,
        wanted: usize,
        printer: &mut Printer<'_>,
    ) -> Result<Self, PrintFailure> {
        let mut numerator = Integer::new(significand);
        let mut denominator = Integer::new(1);
        let binary = if exponent < 0 {
            &mut denominator
        } else {
            &mut numerator
        };
        printer
            .scan(exponent.unsigned_abs() as usize / 32 + 1)
            .await?;
        binary.shift(exponent.unsigned_abs() as usize);
        let decimal = if point > 1 {
            &mut denominator
        } else {
            &mut numerator
        };
        decimal
            .power(10, (point - 1).unsigned_abs() as usize, printer)
            .await?;
        if numerator.compare(&denominator) == Ordering::Less {
            numerator.multiply(10, 0, printer).await?;
            point -= 1;
        }
        let mut ten = denominator.clone();
        ten.multiply(10, 0, printer).await?;
        if numerator.compare(&ten) != Ordering::Less {
            denominator = ten;
            point += 1;
        }
        numerator.power(10, 17, printer).await?;
        let first = numerator.quotient(&denominator, printer).await?;
        let mut digits = first.to_string();
        while digits.len() < wanted && numerator.bits() != 0 {
            numerator.power(10, 18, printer).await?;
            let chunk = numerator.quotient(&denominator, printer).await?;
            write!(digits, "{chunk:018}").expect("writing to String");
        }
        if numerator.bits() != 0 {
            digits.push('1');
        }
        Ok(Self {
            digits: digits.into_bytes(),
            point,
        })
    }

    async fn exact(
        significand: u64,
        exponent: i32,
        printer: &mut Printer<'_>,
    ) -> Result<Self, PrintFailure> {
        let mut integer = Integer::new(significand);
        let scale = if exponent < 0 {
            integer.power(5, (-exponent) as usize, printer).await?;
            exponent
        } else {
            printer.scan(exponent as usize / 32 + 1).await?;
            integer.shift(exponent as usize);
            0
        };
        let digits = integer.decimal(printer).await?;
        let point = digits.len() as i32 + scale;
        Ok(Self { digits, point })
    }

    pub fn round(&mut self, keep: i64) {
        if keep >= self.digits.len() as i64 {
            return;
        }
        if keep < 0 {
            self.digits = vec![b'0'];
            self.point = 1;
            return;
        }
        let keep = keep as usize;
        let next = self.digits[keep];
        let odd = keep != 0 && self.digits[keep - 1] & 1 != 0;
        let tail = self.digits[keep + 1..].iter().any(|digit| *digit != b'0');
        let up = next > b'5' || (next == b'5' && (odd || tail));
        self.digits.truncate(keep);
        if !up {
            self.zero_if_empty();
            return;
        }
        self.increment();
    }

    fn zero_if_empty(&mut self) {
        if self.digits.is_empty() {
            self.digits.push(b'0');
            self.point = 1;
        }
    }

    fn increment(&mut self) {
        for digit in self.digits.iter_mut().rev() {
            if *digit != b'9' {
                *digit += 1;
                return;
            }
            *digit = b'0';
        }
        self.digits.insert(0, b'1');
        self.point += 1;
    }

    pub async fn range(
        &self,
        start: i32,
        length: usize,
        printer: &mut Printer<'_>,
    ) -> Result<(), PrintFailure> {
        let leading = if start < 0 { (-start) as usize } else { 0 }.min(length);
        printer.padding(leading, b'0').await?;
        let start = start.max(0) as usize;
        let count = length - leading;
        let digits = self.digits.get(start..).unwrap_or(b"");
        let count = count.min(digits.len());
        printer.operand(&digits[..count], false).await?;
        printer.padding(length - leading - count, b'0').await
    }
}
