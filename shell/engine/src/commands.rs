//! Original command catalogue. Names belong here; execution and syntactic word
//! recognition stay in their existing feature layers. In particular, keyword
//! queries do not imply that the interpreter implements that keyword's grammar.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Builtin {
    Noop,
    False,
    Echo,
    Printf,
    #[cfg(feature = "acceptance-utilities")]
    AcceptanceUtility(Utility),
    Read,
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
pub(crate) enum Utility {
    Cat,
    Grep,
    Mkdir,
    Seq,
}
impl Utility {
    const fn handler(self) -> Option<Handler> {
        #[cfg(feature = "acceptance-utilities")]
        {
            Some(Handler::Builtin(Builtin::AcceptanceUtility(self)))
        }
        #[cfg(not(feature = "acceptance-utilities"))]
        {
            None
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Handler {
    Builtin(Builtin),
    Command,
    Exec,
    Eval,
    Let,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Class {
    SpecialBuiltin,
    RegularBuiltin,
    AcceptanceUtility,
    Keyword,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Declaration {
    Ordinary,
    AssignmentOperands,
}

/// Compile-time ownership, independent of mutable shell options.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Capability {
    Core,
    AcceptanceUtilities,
}

impl Capability {
    const fn included(self) -> bool {
        match self {
            Self::Core => true,
            Self::AcceptanceUtilities => cfg!(feature = "acceptance-utilities"),
        }
    }
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::AcceptanceUtilities => "acceptance-utilities",
        }
    }
}

pub(crate) const fn build_name() -> &'static str {
    if cfg!(feature = "acceptance-utilities") {
        "Full"
    } else {
        "Lite"
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Availability {
    Included(Capability),
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
            Availability::Included(capability) if capability.included() => self.handler,
            Availability::Included(_) => None,
            Availability::UnsupportedSyntax => None,
        }
    }

    pub(crate) fn omitted_capability(&self) -> Option<Capability> {
        match self.availability {
            Availability::Included(capability) if !capability.included() => Some(capability),
            _ => None,
        }
    }

    /// Query-visible keywords include syntax the current interpreter rejects.
    pub(crate) fn query_keyword(&self) -> bool {
        self.class == Class::Keyword
    }

    /// Stand-ins execute internally but `command -v/-V` must still search PATH.
    pub(crate) fn query_builtin(&self) -> bool {
        matches!(self.class, Class::SpecialBuiltin | Class::RegularBuiltin)
            && self.handler().is_some()
    }

    /// This deliberately differs from query_builtin: grep/mkdir retain shell
    /// heredoc errors, while cat/seq retain command-local heredoc errors.
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
        availability: Availability::Included(Capability::Core),
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
const fn utility(name: &'static str, utility: Utility, heredoc_errors: HeredocErrors) -> Command {
    Command {
        name,
        class: Class::AcceptanceUtility,
        declaration: Declaration::Ordinary,
        availability: Availability::Included(Capability::AcceptanceUtilities),
        handler: utility.handler(),
        heredoc_errors,
    }
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
    utility("cat", Utility::Cat, HeredocErrors::CommandLocal),
    utility("grep", Utility::Grep, HeredocErrors::Shell),
    utility("mkdir", Utility::Mkdir, HeredocErrors::Shell),
    utility("seq", Utility::Seq, HeredocErrors::CommandLocal),
    regular("read", Builtin::Read),
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
    keyword("if", Availability::Included(Capability::Core)),
    keyword("then", Availability::Included(Capability::Core)),
    keyword("else", Availability::Included(Capability::Core)),
    keyword("elif", Availability::Included(Capability::Core)),
    keyword("fi", Availability::Included(Capability::Core)),
    keyword("case", Availability::Included(Capability::Core)),
    keyword("esac", Availability::Included(Capability::Core)),
    keyword("for", Availability::Included(Capability::Core)),
    keyword("select", Availability::UnsupportedSyntax),
    keyword("while", Availability::Included(Capability::Core)),
    keyword("until", Availability::Included(Capability::Core)),
    keyword("do", Availability::Included(Capability::Core)),
    keyword("done", Availability::Included(Capability::Core)),
    keyword("in", Availability::Included(Capability::Core)),
    keyword("function", Availability::Included(Capability::Core)),
    keyword("time", Availability::UnsupportedSyntax),
    keyword("{", Availability::Included(Capability::Core)),
    keyword("}", Availability::Included(Capability::Core)),
    keyword("!", Availability::Included(Capability::Core)),
    keyword("[[", Availability::Included(Capability::Core)),
    keyword("]]", Availability::Included(Capability::Core)),
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
