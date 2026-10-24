use super::super::{PrintFailure, Printer};
use super::{Float, Magnitude, integer::Integer};
use std::cmp::Ordering;

const DIGITS: usize = 12_000;
const RANGE: &[u8] = b": Numerical result out of range\n";

pub(super) async fn parse(
    value: &str,
    printer: &mut Printer<'_>,
) -> Result<(Float, Option<&'static [u8]>), PrintFailure> {
    if matches!(value.as_bytes().first(), Some(b'\'' | b'"')) {
        let character = if printer.utf8 {
            value[1..].chars().next().map(u32::from).unwrap_or(0)
        } else {
            u32::from(value.as_bytes().get(1).copied().unwrap_or(0))
        };
        return Ok((Float::finite(false, u64::from(character), 0), None));
    }
    let input = value.trim_start_matches([' ', '\t', '\n', '\r', '\x0b', '\x0c']);
    let negative = input.starts_with('-');
    let input = input.strip_prefix(['+', '-']).unwrap_or(input).as_bytes();
    if let Some((magnitude, consumed)) = special(input) {
        return Ok((
            Float {
                negative,
                magnitude,
            },
            invalid(value, consumed != input.len()),
        ));
    }
    let hexadecimal = input.starts_with(b"0x") || input.starts_with(b"0X");
    let radix = if hexadecimal { 16 } else { 10 };
    let start = usize::from(hexadecimal) * 2;
    let mut end = start;
    let mut point = None;
    while let Some(byte) = input.get(end) {
        if *byte == b'.' && point.is_none() {
            point = Some(end);
            end += 1;
            continue;
        }
        if digit(*byte, radix).is_none() {
            break;
        }
        end += 1;
    }
    let count = end - start - usize::from(point.is_some());
    if count == 0 {
        return Ok((Float::finite(false, 0, 0), invalid(value, true)));
    }
    let (exponent, consumed) = exponent(input, end, hexadecimal);
    let fraction = point.map_or(0, |point| end - point - 1) as i32;
    let exponent =
        exponent.saturating_sub(fraction.saturating_mul(if hexadecimal { 4 } else { 1 }));
    let _storage = printer.context.admit_builtin_buffer(
        4096 + input.len().min(DIGITS) * 16 + exponent.unsigned_abs().min(60_000) as usize * 2,
    )?;
    let (number, dropped, sticky) = coefficient(&input[start..end], radix, printer).await?;
    let exponent = exponent.saturating_add(dropped.saturating_mul(if hexadecimal { 4 } else { 1 }));
    let (magnitude, range) = convert(number, exponent, hexadecimal, sticky, printer).await?;
    let diagnostic = invalid(value, consumed != input.len()).or(range.then_some(RANGE));
    Ok((
        Float {
            negative,
            magnitude,
        },
        diagnostic,
    ))
}

fn invalid(value: &str, invalid: bool) -> Option<&'static [u8]> {
    if !invalid {
        return None;
    }
    Some(if value.starts_with("0x") {
        b": invalid hex number\n"
    } else {
        b": invalid number\n"
    })
}

fn special(input: &[u8]) -> Option<(Magnitude, usize)> {
    if input
        .get(..8)
        .is_some_and(|s| s.eq_ignore_ascii_case(b"infinity"))
    {
        return Some((Magnitude::Infinity, 8));
    }
    if input
        .get(..3)
        .is_some_and(|s| s.eq_ignore_ascii_case(b"inf"))
    {
        return Some((Magnitude::Infinity, 3));
    }
    if !input
        .get(..3)
        .is_some_and(|s| s.eq_ignore_ascii_case(b"nan"))
    {
        return None;
    }
    let mut end = 3;
    if input.get(end) != Some(&b'(') {
        return Some((Magnitude::Nan, end));
    }
    end += 1;
    while input
        .get(end)
        .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
    {
        end += 1;
    }
    Some((
        Magnitude::Nan,
        if input.get(end) == Some(&b')') {
            end + 1
        } else {
            3
        },
    ))
}

fn digit(byte: u8, radix: u32) -> Option<u32> {
    super::super::hex(byte).filter(|n| *n < radix)
}

fn exponent(input: &[u8], start: usize, hexadecimal: bool) -> (i32, usize) {
    let marker = if hexadecimal { b'p' } else { b'e' };
    if !input
        .get(start)
        .is_some_and(|b| b.to_ascii_lowercase() == marker)
    {
        return (0, start);
    }
    let negative = input.get(start + 1) == Some(&b'-');
    let mut end = start + 1;
    if matches!(input.get(end), Some(b'+' | b'-')) {
        end += 1;
    }
    let digits = end;
    let mut value = 0i32;
    while let Some(byte @ b'0'..=b'9') = input.get(end) {
        value = value
            .saturating_mul(10)
            .saturating_add(i32::from(byte - b'0'));
        end += 1;
    }
    if end == digits {
        return (0, start);
    }
    (if negative { -value } else { value }, end)
}

async fn coefficient(
    input: &[u8],
    radix: u32,
    printer: &mut Printer<'_>,
) -> Result<(Integer, i32, bool), PrintFailure> {
    let mut number = Integer::new(0);
    let group = if radix == 10 { 9 } else { 7 };
    let mut chunk = 0;
    let mut length = 0;
    let mut kept = 0;
    let mut dropped = 0i32;
    let mut sticky = false;
    for byte in input {
        let Some(digit) = digit(*byte, radix) else {
            continue;
        };
        if kept == 0 && digit == 0 {
            continue;
        }
        if kept == DIGITS {
            dropped = dropped.saturating_add(1);
            sticky |= digit != 0;
            continue;
        }
        kept += 1;
        chunk = chunk * radix + digit;
        length += 1;
        if length == group {
            number.multiply(radix.pow(group), chunk, printer).await?;
            chunk = 0;
            length = 0;
        }
    }
    number.multiply(radix.pow(length), chunk, printer).await?;
    Ok((number, dropped, sticky))
}

async fn convert(
    mut numerator: Integer,
    exponent: i32,
    hexadecimal: bool,
    sticky: bool,
    printer: &mut Printer<'_>,
) -> Result<(Magnitude, bool), PrintFailure> {
    if numerator.bits() == 0 {
        return Ok((
            Magnitude::Finite {
                significand: 0,
                exponent: 0,
            },
            false,
        ));
    }
    let order = if hexadecimal {
        numerator.bits().saturating_add(exponent)
    } else {
        ((f64::from(numerator.bits()) * std::f64::consts::LOG10_2) as i32)
            .saturating_add(exponent)
    };
    let bound = if hexadecimal { 16_500 } else { 5_000 };
    if order > bound {
        return Ok((Magnitude::Infinity, true));
    }
    if order < -bound {
        return Ok((
            Magnitude::Finite {
                significand: 0,
                exponent: 0,
            },
            true,
        ));
    }
    let mut denominator = Integer::new(1);
    let target = if exponent < 0 {
        &mut denominator
    } else {
        &mut numerator
    };
    if hexadecimal {
        printer
            .scan(exponent.unsigned_abs() as usize / 32 + 1)
            .await?;
        target.shift(exponent.unsigned_abs() as usize);
    } else {
        target
            .power(10, exponent.unsigned_abs() as usize, printer)
            .await?;
    }
    binary(numerator, denominator, sticky, printer).await
}

async fn binary(
    mut numerator: Integer,
    mut denominator: Integer,
    sticky: bool,
    printer: &mut Printer<'_>,
) -> Result<(Magnitude, bool), PrintFailure> {
    let mut exponent = numerator.bits() - denominator.bits();
    let mut comparison = if exponent < 0 {
        numerator.clone()
    } else {
        denominator.clone()
    };
    comparison.shift(exponent.unsigned_abs() as usize);
    let order = if exponent < 0 {
        comparison.compare(&denominator)
    } else {
        numerator.compare(&comparison)
    };
    exponent -= i32::from(order == Ordering::Less);
    if exponent > 16_383 {
        return Ok((Magnitude::Infinity, true));
    }
    if exponent < -16_446 {
        return Ok((
            Magnitude::Finite {
                significand: 0,
                exponent: 0,
            },
            true,
        ));
    }
    let scale = (exponent - 63).max(-16_445);
    if scale < 0 {
        numerator.shift((-scale) as usize);
    } else {
        denominator.shift(scale as usize);
    }
    let significand = numerator.quotient(&denominator, printer).await?;
    let inexact = numerator.bits() != 0 || sticky;
    numerator.shift(1);
    let half = numerator.compare(&denominator);
    let round =
        half == Ordering::Greater || (half == Ordering::Equal && (significand & 1 != 0 || sticky));
    let rounded = u128::from(significand) + u128::from(round);
    let carry = rounded > u128::from(u64::MAX);
    let scale = scale + i32::from(carry);
    if scale > 16_320 {
        return Ok((Magnitude::Infinity, true));
    }
    let significand = (rounded >> u32::from(carry)) as u64;
    let range = scale == -16_445 && significand < 1 << 63 && inexact;
    Ok((
        Magnitude::Finite {
            significand,
            exponent: scale,
        },
        range,
    ))
}
