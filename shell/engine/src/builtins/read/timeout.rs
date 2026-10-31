use crate::{
    exec::{Error, Work},
    executor::{Cancel, Sleep},
    io::{Endpoint, IoError},
};
use std::{future::Future, pin::Pin, task::Poll, time::Duration};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Timeout {
    Ready,
    After(Duration),
}

pub(super) async fn parse(
    value: &str,
    cancel: &Cancel,
    work: &mut Work,
) -> Result<Option<Timeout>, Error> {
    let mut number = Number::default();
    for (index, byte) in value.bytes().enumerate() {
        work.checkpoint(cancel).await?;
        number.byte(index, byte);
    }
    Ok(number.finish())
}

#[derive(Default)]
struct Number {
    negative: bool,
    seconds: u64,
    micros: i64,
    fraction: Option<u32>,
    invalid: bool,
}

impl Number {
    fn byte(&mut self, index: usize, byte: u8) {
        if index == 0 && matches!(byte, b'+' | b'-') {
            self.negative = byte == b'-';
            return;
        }
        if byte == b'.' && self.fraction.is_none() {
            self.fraction = Some(0);
            return;
        }
        if !byte.is_ascii_digit() {
            self.invalid = true;
            return;
        }
        let digit = byte - b'0';
        match self.fraction.as_mut() {
            None => self.seconds = self.seconds.wrapping_mul(10).wrapping_add(u64::from(digit)),
            Some(count) if *count < 6 => {
                self.micros = self.micros * 10 + i64::from(digit);
                *count += 1;
            }
            Some(_) => {}
        }
    }

    fn finish(mut self) -> Option<Timeout> {
        let mut seconds = i64::from_ne_bytes(self.seconds.to_ne_bytes());
        self.micros *= 10i64.pow(6 - self.fraction.unwrap_or(6));
        if self.negative {
            seconds = seconds.wrapping_neg();
            self.micros = -self.micros;
        }
        if self.invalid || seconds < 0 || self.micros < 0 {
            return None;
        }
        let seconds = (seconds as u64) & u64::from(u32::MAX);
        if seconds == 0 && self.micros == 0 {
            return Some(Timeout::Ready);
        }
        Some(Timeout::After(Duration::new(
            seconds,
            self.micros as u32 * 1000,
        )))
    }
}

pub(super) async fn arm(sleep: &mut Sleep) -> bool {
    std::future::poll_fn(|cx| Poll::Ready(Pin::new(&mut *sleep).poll(cx).is_ready())).await
}

pub(super) async fn read(
    input: &Endpoint,
    output: &mut [u8],
    cancel: &Cancel,
    sleep: Option<&mut Sleep>,
) -> Result<Option<usize>, IoError> {
    let Some(sleep) = sleep else {
        return input.read_cancelled(output, cancel).await.map(Some);
    };
    let read = input.read_cancelled(output, cancel);
    let mut read = std::pin::pin!(read);
    std::future::poll_fn(|cx| {
        if cancel.probe_now() {
            return Poll::Ready(Err(IoError::Cancelled));
        }
        if sleep.is_elapsed() {
            return Poll::Ready(Ok(None));
        }
        if let Poll::Ready(result) = read.as_mut().poll(cx) {
            return Poll::Ready(result.map(Some));
        }
        match Pin::new(&mut *sleep).poll(cx) {
            Poll::Ready(()) => Poll::Ready(Ok(None)),
            Poll::Pending => Poll::Pending,
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::Executor;
    use futures::FutureExt;
    use std::time::Instant;

    fn complete<T>(future: impl Future<Output = T>) -> T {
        let mut future = std::pin::pin!(future);
        for _ in 0..1000 {
            if let Some(value) = future.as_mut().now_or_never() {
                return value;
            }
        }
        panic!("bounded parser did not complete");
    }

    fn parsed(value: &str) -> Option<Timeout> {
        complete(parse(value, &Cancel::new(), &mut Work::new(1000, 0, 0)))
            .unwrap_or_else(|_| panic!("parser failed"))
    }

    #[test]
    fn bash_5315_wrapping_signed_seconds_and_truncated_fraction() {
        for value in [
            "",
            ".",
            "+.",
            "-.",
            "+",
            "-",
            "0",
            "-0",
            "-0.0000001",
            "4294967296",
            "+4294967296",
            "18446744073709551616",
            "-18446744073709551616",
        ] {
            assert_eq!(parsed(value), Some(Timeout::Ready), "{value:?}");
        }
        for (value, seconds, micros) in [
            ("1", 1, 0),
            ("+1", 1, 0),
            (".2", 0, 200000),
            ("1.0000019", 1, 1),
            ("4294967295", 4294967295, 0),
            ("4294967297", 1, 0),
            ("4294967296.5", 0, 500000),
            ("9223372036854775807", 4294967295, 0),
            ("-9223372036854775809", 4294967295, 0),
            ("18446744073709551617", 1, 0),
            ("18446744073709551616.123456789", 0, 123456),
        ] {
            assert_eq!(
                parsed(value),
                Some(Timeout::After(Duration::new(seconds, micros * 1000))),
                "{value}"
            );
        }
        for value in [
            " ",
            " 1",
            "1 ",
            "1e2",
            "0x1",
            "1.2.3",
            "--1",
            "+-0",
            "nan",
            "-0.000001",
            "-1",
            "-4294967296",
            "-4294967297",
            "9223372036854775808",
            "18446744073709551615",
            "-9223372036854775808",
            "-18446744073709551617",
            "99999999999999999999999999999999999999999999999999",
        ] {
            assert_eq!(parsed(value), None, "{value:?}");
        }
    }

    #[test]
    fn parser_charges_discarded_digits_and_invalid_suffix_cooperatively() {
        let executor = Executor::new();
        let value = format!(".{}bad", "1".repeat(10000));
        let cancel = Cancel::new();
        let child_cancel = cancel.clone();
        let job = executor.spawn(async move {
            parse(&value, &child_cancel, &mut Work::new(20000, 0, 0))
                .await
                .is_err()
        });
        executor.drive(1);
        assert!(!job.is_finished());
        cancel.cancel();
        executor.drive(1);
        assert!(job.now_or_never().unwrap());
        let mut work = Work::new(100, 0, 0);
        assert!(complete(parse(&"x".repeat(1000), &Cancel::new(), &mut work)).is_err());
    }

    #[test]
    fn dropping_pending_read_and_timer_preserves_pipe_bytes() {
        let executor = Executor::new();
        let (input, writer) = crate::io::pipe();
        let cancel = Cancel::new();
        let mut timer = executor.sleep_until(Instant::now() + Duration::from_secs(60));
        assert!(!arm(&mut timer).now_or_never().unwrap());
        let mut bytes = [0; 3];
        let mut pending = Box::pin(read(&input, &mut bytes, &cancel, Some(&mut timer)));
        assert!(pending.as_mut().now_or_never().is_none());
        drop(pending);
        drop(timer);
        assert!(executor.next_deadline().is_none());
        assert_eq!(writer.write(b"abc").now_or_never(), Some(Ok(3)));
        assert_eq!(input.read(&mut bytes).now_or_never(), Some(Ok(3)));
        assert_eq!(&bytes, b"abc");
        assert!(input.read(&mut bytes).now_or_never().is_none());
    }
}
