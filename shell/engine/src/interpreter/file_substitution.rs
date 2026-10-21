use super::*;

impl Substitutions {
    pub(crate) async fn open_substitution_file(
        &self,
        target: &str,
        state: &SharedState,
        work: &mut expand::Work,
    ) -> Result<Option<io::Endpoint>, expand::Error> {
        work.checkpoint(&self.context.cancel).await?;
        let device = io::device_endpoint(target, &self.fds.borrow());
        let result = if let Some(device) = device {
            device.map_err(|_| io::IoError::BadDescriptor)
        } else {
            work.admit_storage(
                state
                    .borrow()
                    .cwd
                    .len()
                    .saturating_add(target.len())
                    .saturating_add(1),
            )?;
            let path = absolute(&state.borrow().cwd, target);
            self.context
                .cancel
                .run(self.context.fs().open(&path, &OpenOptions::default()))
                .await
                .map_err(|_| 130)?
        };
        match result {
            Ok(endpoint) => Ok(Some(endpoint)),
            Err(io::IoError::Cancelled) => Err(130.into()),
            Err(error) => {
                let message = match error {
                    io::IoError::NotFound => "No such file or directory",
                    io::IoError::BadDescriptor => "Bad file descriptor",
                    _ => "cannot open input file",
                };
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
        if let Some(stderr) = self.stderr() {
            for part in ["/usr/bin/bash: ", target, ": ", message, "\n"] {
                let _ = stderr.write_all(part.as_bytes(), self.cancel()).await;
            }
        }
        if self.cancel().is_cancelled() {
            return Err(130.into());
        }
        Ok(())
    }
}
