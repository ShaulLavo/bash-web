use super::*;

fn input(fake: &Fake, bytes: Vec<u8>) {
    fake.fds.borrow_mut().insert(0, Endpoint::bytes(bytes));
}

#[test]
fn raw_exact_c_read_batches_runtime_calls_without_consuming_an_alias_sentinel() {
    let (executor, fake, runtime) = setup();
    input(&fake, vec![b'x'; 65536].into_iter().chain(*b"!\n").collect());
    let session = runtime_session(&executor, &runtime);
    let source = "LC_ALL=C; exec 3<&0; read -r -N65536 value; printf '%s:%s:' \"$?\" \"${#value}\"; read -r -u3 tail; printf '%s' \"$tail\"; exec 3<&-";
    assert_eq!(finish(&executor, &runtime, session.start(source).unwrap()), 0);
    assert_eq!(fake.output.bytes(), b"0:65536:!");
    let reads = fake.reads.borrow();
    let requests: Vec<_> = reads.iter().map(|(_, length)| *length).collect();
    eprintln!("raw exact 65536 plus sentinel: calls={} max={}", requests.len(), requests.iter().max().unwrap());
    assert!(requests.len() <= 18, "requests={}", requests.len());
    assert_eq!(requests.iter().copied().max(), Some(4096));
    assert_eq!(requests.iter().sum::<usize>(), 65538);
    drop(reads);
    shutdown_session(&executor, &runtime, &fake, session);
}
