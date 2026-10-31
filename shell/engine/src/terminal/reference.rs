use serde::Deserialize;

#[derive(Deserialize)]
pub(super) struct Reference {
    pub cases: Vec<Case>,
}
#[derive(Deserialize)]
pub(super) struct Case {
    pub name: String,
    pub columns: usize,
    pub history: Vec<String>,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub parity: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Step {
    pub key: String,
    pub input_hex: String,
    pub line: String,
    pub point: usize,
    #[serde(default)]
    pub history_offset: usize,
}
