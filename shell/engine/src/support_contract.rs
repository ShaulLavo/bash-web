use crate::{
    executor::{Cancel, Executor},
    io::{self, Endpoint, FdTable, IoError, MemoryFs, OpenOptions, PIPE_CAPACITY},
};
use futures::FutureExt;

#[test]
fn eof_requires_the_last_open_writer_description_to_close() {
    let executor = Executor::new();
    let (reader, writer) = io::pipe();
    let mut descriptors = FdTable::default();
    descriptors.insert(7, writer);
    let inherited = descriptors.clone();
    let read = executor.spawn(async move { reader.read(&mut [0]).await });
    assert_eq!(executor.drive(8).pending, 1);
    drop(descriptors.remove(7));
    assert_eq!(executor.drive(8).polls, 0);
    assert!(!read.is_finished());
    drop(inherited);
    assert_eq!(executor.drive(8).pending, 0);
    assert_eq!(read.now_or_never(), Some(Ok(0)));
}

#[test]
fn full_pipe_parks_until_reader_drains_without_partial_atomic_records() {
    let executor = Executor::new();
    let (reader, writer) = io::pipe();
    assert_eq!(
        writer.write(&vec![b'x'; PIPE_CAPACITY - 1]).now_or_never(),
        Some(Ok(PIPE_CAPACITY - 1))
    );
    let write = executor.spawn(async move { writer.write(b"abc").await });
    assert_eq!(executor.drive(8).pending, 1);
    assert_eq!(executor.drive(8).polls, 0);
    assert_eq!(reader.read(&mut [0; 2]).now_or_never(), Some(Ok(2)));
    assert_eq!(executor.drive(8).pending, 0);
    assert_eq!(write.now_or_never(), Some(Ok(3)));
    let mut remaining = vec![0; PIPE_CAPACITY];
    assert_eq!(
        reader.read(&mut remaining).now_or_never(),
        Some(Ok(PIPE_CAPACITY))
    );
    assert_eq!(&remaining[PIPE_CAPACITY - 3..], b"abc");
}

#[test]
fn closing_last_reader_wakes_a_blocked_writer_with_broken_pipe() {
    let executor = Executor::new();
    let (reader, writer) = io::pipe();
    assert_eq!(
        writer.write(&vec![0; PIPE_CAPACITY]).now_or_never(),
        Some(Ok(PIPE_CAPACITY))
    );
    let write = executor.spawn(async move { writer.write(b"x").await });
    executor.drive(8);
    let alias = reader.clone();
    drop(reader);
    assert_eq!(executor.drive(8).polls, 0);
    drop(alias);
    executor.drive(8);
    assert_eq!(write.now_or_never(), Some(Err(IoError::BrokenPipe)));
}

#[test]
fn cancelling_parked_read_does_not_consume_later_bytes() {
    let executor = Executor::new();
    let (reader, writer) = io::pipe();
    let cancel = Cancel::new();
    let pending = reader.clone();
    let interrupted = cancel.clone();
    let read = executor.spawn(async move { pending.read_cancelled(&mut [0], &interrupted).await });
    executor.drive(8);
    cancel.cancel();
    executor.drive(8);
    assert_eq!(read.now_or_never(), Some(Err(IoError::Cancelled)));
    assert_eq!(writer.write(b"z").now_or_never(), Some(Ok(1)));
    let mut byte = [0];
    assert_eq!(reader.read(&mut byte).now_or_never(), Some(Ok(1)));
    assert_eq!(&byte, b"z");
}

#[test]
fn child_abort_is_local_and_parent_cancel_wakes_descendants() {
    let executor = Executor::new();
    let parent = Cancel::new();
    let first = parent.child();
    let sibling = parent.child();
    first.cancel();
    assert!(!parent.is_cancelled());
    assert!(!sibling.is_cancelled());
    let read = executor.spawn(async move { sibling.cancelled().await });
    executor.drive(8);
    assert!(!read.is_finished());
    parent.cancel();
    executor.drive(8);
    assert!(read.is_finished());
}

#[test]
fn weak_descriptor_observation_does_not_hold_a_pipe_open() {
    let (reader, writer) = io::pipe();
    let observer = writer.downgrade();
    assert!(observer.upgrade().is_some());
    drop(writer);
    assert!(observer.upgrade().is_none());
    assert_eq!(reader.read(&mut [0]).now_or_never(), Some(Ok(0)));
}

#[test]
fn descriptor_clones_share_offsets_but_reopens_do_not() {
    let fs = MemoryFs::new(16);
    fs.write_file("/data", b"abc").unwrap();
    let source = fs.open("/data", &OpenOptions::default()).unwrap();
    let alias = source.clone();
    let reopened = fs.open("/data", &OpenOptions::default()).unwrap();
    let mut byte = [0];
    assert_eq!(source.read(&mut byte).now_or_never(), Some(Ok(1)));
    assert_eq!(alias.read(&mut byte).now_or_never(), Some(Ok(1)));
    assert_eq!(&byte, b"b");
    assert_eq!(reopened.read(&mut byte).now_or_never(), Some(Ok(1)));
    assert_eq!(&byte, b"a");
}

#[test]
fn buffered_pump_source_shares_offset_without_holding_exported_descriptor() {
    let input = Endpoint::bytes(b"abc".to_vec());
    let source = input.buffered_source();
    assert_eq!(input.buffered_input_bytes(), Some(3));
    assert_eq!(input.read(&mut [0]).now_or_never(), Some(Ok(1)));
    let mut rest = [0; 2];
    assert_eq!(source.read(&mut rest).now_or_never(), Some(Ok(2)));
    assert_eq!(&rest, b"bc");
    assert!(source.runtime_fd().is_none());
    assert!(source.host_owner().is_none());
}
