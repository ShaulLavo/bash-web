use super::*;

impl Substitutions {
    pub(crate) async fn open_substitution_file(
        &self,
        target: &str,
        state: &SharedState,
        work: &mut expand::Work,
    ) -> Result<Option<io::Endpoint>, expand::Error> {
        work.checkpoint(&self.context.cancel).await?;
        work.admit_storage(
            state
                .borrow()
                .cwd
                .len()
                .saturating_add(target.len())
                .saturating_add(1),
        )?;
        let path = absolute(&state.borrow().cwd, target);
        let options = OpenOptions::default();
        let opening = io::open_path(&path, &self.fds.borrow(), &options);
        let result = match opening {
            Ok(opening) => self
                .context
                .cancel
                .run(opening.open(self.context.fs(), &options))
                .await
                .map_err(|_| 130)?,
            Err(error) => Err(error),
        };
        match result {
            Ok(endpoint) => Ok(Some(endpoint)),
            Err(io::IoError::Cancelled) => Err(130.into()),
            Err(error) => {
                let message = open_error_message(error);
                self.file_substitution_error(target, message).await?;
                Ok(None)
            }
        }
    }

    pub(crate) async fn file_substitution_error(
        &self,
        target: &str,
        message: &str,
    ) -> Result<(), expand::Error> {
        self.diagnose(&["/usr/bin/bash: ", target, ": ", message, "\n"])
            .await
    }
}

fn open_error_message(error: io::IoError) -> &'static str {
    match error {
        io::IoError::NotFound => "No such file or directory",
        io::IoError::BadDescriptor => "Bad file descriptor",
        _ => "cannot open input file",
    }
}
