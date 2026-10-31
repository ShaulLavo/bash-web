//! Original command catalogue. Names belong here; execution and syntactic word
//! recognition stay in their existing feature layers. In particular, keyword
//! queries do not imply that the interpreter implements that keyword's grammar.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Builtin {
    Help,
    Noop,
    False,
    Echo,
    Printf,
    Read,
    Mapfile,
    Getopts,
    Caller,
    Trap,
    Declaration,
    Cd,
    Pwd,
    Pushd,
    Popd,
    Dirs,
    Set,
    Shift,
    Shopt,
    Alias,
    ExitReturn,
    Jobs,
    Wait,
    Kill,
    Unset,
    Test,
    LoopControl,
    Completion,
    Enable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Handler {
    Builtin(Builtin),
    Command,
    BuiltinWrapper,
    Type,
    Hash,
    Exec,
    Eval,
    Source,
    Let,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Class {
    SpecialBuiltin,
    RegularBuiltin,
    Keyword,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Declaration {
    Ordinary,
    AssignmentOperands,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Availability {
    Included,
    UnsupportedSyntax,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HeredocErrors {
    Shell,
    CommandLocal,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Command {
    pub(crate) name: &'static str,
    pub(crate) class: Class,
    pub(crate) declaration: Declaration,
    pub(crate) availability: Availability,
    handler: Option<Handler>,
    heredoc_errors: HeredocErrors,
}
impl Command {
    pub(crate) fn handler(&self) -> Option<Handler> {
        match self.availability {
            Availability::Included => self.handler,
            Availability::UnsupportedSyntax => None,
        }
    }

    /// Query-visible keywords include syntax the current interpreter rejects.
    pub(crate) fn query_keyword(&self) -> bool {
        self.class == Class::Keyword
    }

    pub(crate) fn query_builtin(&self) -> bool {
        matches!(self.class, Class::SpecialBuiltin | Class::RegularBuiltin)
            && self.handler().is_some()
    }

    pub(crate) fn shell_heredoc_errors(&self) -> bool {
        self.heredoc_errors == HeredocErrors::Shell && self.handler().is_some()
    }
}

const fn core(
    name: &'static str,
    class: Class,
    declaration: Declaration,
    handler: Handler,
) -> Command {
    Command {
        name,
        class,
        declaration,
        availability: Availability::Included,
        handler: Some(handler),
        heredoc_errors: HeredocErrors::Shell,
    }
}
const fn regular(name: &'static str, builtin: Builtin) -> Command {
    core(
        name,
        Class::RegularBuiltin,
        Declaration::Ordinary,
        Handler::Builtin(builtin),
    )
}
const fn special(name: &'static str, handler: Handler) -> Command {
    core(name, Class::SpecialBuiltin, Declaration::Ordinary, handler)
}
const fn declaration(name: &'static str, class: Class) -> Command {
    core(
        name,
        class,
        Declaration::AssignmentOperands,
        Handler::Builtin(Builtin::Declaration),
    )
}
const fn keyword(name: &'static str, availability: Availability) -> Command {
    Command {
        name,
        class: Class::Keyword,
        declaration: Declaration::Ordinary,
        availability,
        handler: None,
        heredoc_errors: HeredocErrors::CommandLocal,
    }
}

/// Single production spelling source for all engine command views. The parser's
/// reserved-word and compound-array declaration grammar is a separate authority;
/// it is not replaced by expanded-name command metadata.
static COMMANDS: &[Command] = &[
    core(
        "hash",
        Class::RegularBuiltin,
        Declaration::Ordinary,
        Handler::Hash,
    ),
    special(":", Handler::Builtin(Builtin::Noop)),
    regular("true", Builtin::Noop),
    regular("help", Builtin::Help),
    regular("false", Builtin::False),
    regular("enable", Builtin::Enable),
    regular("echo", Builtin::Echo),
    regular("printf", Builtin::Printf),
    regular("read", Builtin::Read),
    regular("mapfile", Builtin::Mapfile),
    regular("readarray", Builtin::Mapfile),
    regular("getopts", Builtin::Getopts),
    regular("caller", Builtin::Caller),
    regular("compgen", Builtin::Completion),
    regular("complete", Builtin::Completion),
    regular("compopt", Builtin::Completion),
    special("trap", Handler::Builtin(Builtin::Trap)),
    declaration("export", Class::SpecialBuiltin),
    declaration("local", Class::RegularBuiltin),
    declaration("readonly", Class::SpecialBuiltin),
    declaration("declare", Class::RegularBuiltin),
    declaration("typeset", Class::RegularBuiltin),
    regular("cd", Builtin::Cd),
    regular("pwd", Builtin::Pwd),
    regular("pushd", Builtin::Pushd),
    regular("popd", Builtin::Popd),
    regular("dirs", Builtin::Dirs),
    special("set", Handler::Builtin(Builtin::Set)),
    special("shift", Handler::Builtin(Builtin::Shift)),
    core(
        "command",
        Class::RegularBuiltin,
        Declaration::Ordinary,
        Handler::Command,
    ),
    core(
        "builtin",
        Class::RegularBuiltin,
        Declaration::Ordinary,
        Handler::BuiltinWrapper,
    ),
    core(
        "type",
        Class::RegularBuiltin,
        Declaration::Ordinary,
        Handler::Type,
    ),
    regular("shopt", Builtin::Shopt),
    regular("alias", Builtin::Alias),
    regular("unalias", Builtin::Alias),
    special("exit", Handler::Builtin(Builtin::ExitReturn)),
    special("return", Handler::Builtin(Builtin::ExitReturn)),
    regular("jobs", Builtin::Jobs),
    regular("wait", Builtin::Wait),
    regular("kill", Builtin::Kill),
    special("unset", Handler::Builtin(Builtin::Unset)),
    regular("test", Builtin::Test),
    regular("[", Builtin::Test),
    special("break", Handler::Builtin(Builtin::LoopControl)),
    special("continue", Handler::Builtin(Builtin::LoopControl)),
    special("exec", Handler::Exec),
    special("eval", Handler::Eval),
    special(".", Handler::Source),
    core(
        "source",
        Class::RegularBuiltin,
        Declaration::Ordinary,
        Handler::Source,
    ),
    core(
        "let",
        Class::RegularBuiltin,
        Declaration::Ordinary,
        Handler::Let,
    ),
    keyword("if", Availability::Included),
    keyword("then", Availability::Included),
    keyword("else", Availability::Included),
    keyword("elif", Availability::Included),
    keyword("fi", Availability::Included),
    keyword("case", Availability::Included),
    keyword("esac", Availability::Included),
    keyword("for", Availability::Included),
    keyword("select", Availability::Included),
    keyword("while", Availability::Included),
    keyword("until", Availability::Included),
    keyword("do", Availability::Included),
    keyword("done", Availability::Included),
    keyword("in", Availability::Included),
    keyword("function", Availability::Included),
    keyword("time", Availability::Included),
    keyword("{", Availability::Included),
    keyword("}", Availability::Included),
    keyword("!", Availability::Included),
    keyword("[[", Availability::Included),
    keyword("]]", Availability::Included),
    keyword("coproc", Availability::UnsupportedSyntax),
];

pub(crate) const COMMAND_COUNT: usize = COMMANDS.len();

const _: () = assert!(COMMAND_COUNT <= u128::BITS as usize);

pub(crate) fn enabled(name: &str, disabled: u128) -> bool {
    builtin_index(name).is_some_and(|index| disabled & (1 << index) == 0)
}

pub(crate) fn enabled_handler(name: &str, disabled: u128) -> Option<Handler> {
    handler(name).filter(|_| enabled(name, disabled))
}

pub(crate) fn set_enabled(name: &str, disabled: &mut u128, enabled: bool) -> bool {
    let Some(index) = builtin_index(name) else {
        return false;
    };
    if enabled {
        *disabled &= !(1 << index);
    } else {
        *disabled |= 1 << index;
    }
    true
}

fn builtin_index(name: &str) -> Option<usize> {
    COMMANDS
        .iter()
        .position(|command| command.name == name && command.query_builtin())
}

pub(crate) fn catalogue() -> &'static [Command] {
    COMMANDS
}

pub(crate) fn lookup(name: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|command| command.name == name)
}

pub(crate) fn handler(name: &str) -> Option<Handler> {
    lookup(name).and_then(Command::handler)
}

#[cfg(test)]
mod tests;
