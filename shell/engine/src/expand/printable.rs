//! Locale character classification shared by printf %q and `${name@Q}`.
#[cfg(not(target_os = "wasi"))]
use std::ffi::c_void;

unsafe extern "C" {
    #[cfg(target_os = "wasi")]
    fn iswprint(character: u32) -> i32;
    #[cfg(not(target_os = "wasi"))]
    fn iswprint_l(character: u32, locale: *mut c_void) -> i32;
    #[cfg(not(target_os = "wasi"))]
    fn newlocale(mask: i32, name: *const std::ffi::c_char, base: *mut c_void) -> *mut c_void;
    #[cfg(all(not(target_os = "wasi"), not(target_vendor = "apple")))]
    fn freelocale(locale: *mut c_void);
    #[cfg(target_vendor = "apple")]
    fn freelocale(locale: *mut c_void) -> i32;
}

pub(crate) struct Printability {
    #[cfg(not(target_os = "wasi"))]
    locale: *mut c_void,
}
impl Printability {
    pub(crate) fn new(utf8: bool) -> Result<Self, i32> {
        #[cfg(target_os = "wasi")]
        let classification = {
            let _ = utf8;
            Self {}
        };
        #[cfg(not(target_os = "wasi"))]
        let classification = Self {
            locale: character_locale(utf8)?,
        };
        Ok(classification)
    }
    pub(crate) fn printable(&self, character: char) -> bool {
        #[cfg(target_os = "wasi")]
        unsafe {
            iswprint(u32::from(character)) != 0
        }
        #[cfg(not(target_os = "wasi"))]
        unsafe {
            iswprint_l(u32::from(character), self.locale) != 0
        }
    }
}
#[cfg(not(target_os = "wasi"))]
fn character_locale(utf8: bool) -> Result<*mut c_void, i32> {
    if !utf8 {
        return Ok(std::ptr::null_mut());
    }
    #[cfg(target_vendor = "apple")]
    const CTYPE_MASK: i32 = 1 << 1;
    #[cfg(not(target_vendor = "apple"))]
    const CTYPE_MASK: i32 = 1;
    #[cfg(target_vendor = "apple")]
    let locale = unsafe { newlocale(CTYPE_MASK, c"en_US.UTF-8".as_ptr(), std::ptr::null_mut()) };
    #[cfg(not(target_vendor = "apple"))]
    let locale = unsafe { newlocale(CTYPE_MASK, c"C.UTF-8".as_ptr(), std::ptr::null_mut()) };
    if locale.is_null() {
        return Err(2);
    }
    Ok(locale)
}
#[cfg(not(target_os = "wasi"))]
impl Drop for Printability {
    fn drop(&mut self) {
        if !self.locale.is_null() {
            unsafe { freelocale(self.locale) };
        }
    }
}
