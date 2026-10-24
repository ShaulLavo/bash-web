//! POSIX character names shared by shell glob filters and the ASCII ERE adapter.
use unicode_properties::{GeneralCategory, UnicodeGeneralCategory};

#[derive(Clone, Copy)]
pub(crate) enum Named {
    Alnum,
    Alpha,
    Blank,
    Cntrl,
    Digit,
    Graph,
    Lower,
    Print,
    Punct,
    Space,
    Upper,
    Xdigit,
}
impl Named {
    pub(crate) fn parse(name: &[u8]) -> Option<Self> {
        Some(match name {
            b"alnum" => Self::Alnum,
            b"alpha" => Self::Alpha,
            b"blank" => Self::Blank,
            b"cntrl" => Self::Cntrl,
            b"digit" => Self::Digit,
            b"graph" => Self::Graph,
            b"lower" => Self::Lower,
            b"print" => Self::Print,
            b"punct" => Self::Punct,
            b"space" => Self::Space,
            b"upper" => Self::Upper,
            b"xdigit" => Self::Xdigit,
            _ => return None,
        })
    }
    pub(crate) fn matches(self, ch: char, utf8: bool) -> bool {
        if ch.is_ascii() {
            return self.ascii(ch);
        }
        if !utf8 {
            return false;
        }
        let category = ch.general_category();
        let control = matches!(
            category,
            GeneralCategory::Control
                | GeneralCategory::LineSeparator
                | GeneralCategory::ParagraphSeparator
        );
        let printable = !control && category != GeneralCategory::Unassigned;
        match self {
            Self::Alnum | Self::Alpha => {
                ch.is_alphabetic() || category == GeneralCategory::DecimalNumber
            }
            Self::Blank => {
                ch.is_whitespace()
                    && !matches!(
                        ch,
                        '\u{85}' | '\u{a0}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
                    )
            }
            Self::Cntrl => control,
            Self::Digit | Self::Xdigit => false,
            Self::Graph => printable && !Self::Space.matches(ch, true),
            Self::Lower => ch.is_lowercase(),
            Self::Print => printable,
            Self::Punct => Self::Graph.matches(ch, true) && !Self::Alnum.matches(ch, true),
            Self::Space => ch.is_whitespace() && !matches!(ch, '\u{85}' | '\u{a0}' | '\u{202f}'),
            Self::Upper => ch.is_uppercase(),
        }
    }
    fn ascii(self, ch: char) -> bool {
        match self {
            Self::Alnum => ch.is_ascii_alphanumeric(),
            Self::Alpha => ch.is_ascii_alphabetic(),
            Self::Blank => matches!(ch, ' ' | '\t'),
            Self::Cntrl => ch.is_ascii_control(),
            Self::Digit => ch.is_ascii_digit(),
            Self::Graph => ch.is_ascii_graphic(),
            Self::Lower => ch.is_ascii_lowercase(),
            Self::Print => ch == ' ' || ch.is_ascii_graphic(),
            Self::Punct => ch.is_ascii_punctuation(),
            Self::Space => matches!(ch, ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c'),
            Self::Upper => ch.is_ascii_uppercase(),
            Self::Xdigit => ch.is_ascii_hexdigit(),
        }
    }
}
