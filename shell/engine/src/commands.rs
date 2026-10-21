//! Original command catalogue. Names belong here; execution and syntactic word
//! recognition stay in their existing feature layers. In particular, keyword
//! queries do not imply that the interpreter implements that keyword's grammar.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Builtin {
    Noop,
    False,
    Echo,
    Printf,
    Read,
    Getopts,
    Declaration,
    Cd,
    Pwd,
    Set,
    Shift,
    Shopt,
    ExitReturn,
    Jobs,
    Wait,
    Kill,
    Unset,
    Test,
    LoopControl,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Handler {
    Builtin(Builtin),
    Command,
    BuiltinWrapper,
    Type,
    Exec,
    Eval,
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
    special(":", Handler::Builtin(Builtin::Noop)),
    regular("true", Builtin::Noop),
    regular("false", Builtin::False),
    regular("echo", Builtin::Echo),
    regular("printf", Builtin::Printf),
    regular("read", Builtin::Read),
    regular("getopts", Builtin::Getopts),
    declaration("export", Class::SpecialBuiltin),
    declaration("local", Class::RegularBuiltin),
    declaration("readonly", Class::SpecialBuiltin),
    declaration("declare", Class::RegularBuiltin),
    declaration("typeset", Class::RegularBuiltin),
    regular("cd", Builtin::Cd),
    regular("pwd", Builtin::Pwd),
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
    keyword("select", Availability::UnsupportedSyntax),
    keyword("while", Availability::Included),
    keyword("until", Availability::Included),
    keyword("do", Availability::Included),
    keyword("done", Availability::Included),
    keyword("in", Availability::Included),
    keyword("function", Availability::Included),
    keyword("time", Availability::UnsupportedSyntax),
    keyword("{", Availability::Included),
    keyword("}", Availability::Included),
    keyword("!", Availability::Included),
    keyword("[[", Availability::Included),
    keyword("]]", Availability::Included),
    keyword("coproc", Availability::UnsupportedSyntax),
];

pub(crate) fn lookup(name: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|command| command.name == name)
}

pub(crate) fn handler(name: &str) -> Option<Handler> {
    lookup(name).and_then(Command::handler)
}

#[cfg(test)]
mod tests;
