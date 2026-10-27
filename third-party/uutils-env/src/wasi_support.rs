// Local WASI restrictions for upstream env. See ../wasi.patch and provenance.json.
use uucore::error::{UResult, USimpleError};

pub fn validate_options(matches: &clap::ArgMatches) -> UResult<()> {
    let signal_option = ["ignore-signal", "default-signal", "block-signal"]
        .into_iter()
        .any(|option| matches.contains_id(option));
    if signal_option || matches.get_flag("list-signal-handling") {
        return Err(USimpleError::new(
            125,
            "signal options are unsupported on WASI",
        ));
    }
    Ok(())
}

pub fn validate_execution(opts: &super::Options<'_>) -> UResult<()> {
    if opts.program.is_empty() {
        return Ok(());
    }
    Err(USimpleError::new(
        125,
        "program execution is unsupported on this runtime",
    ))
}
