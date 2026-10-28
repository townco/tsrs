// Not a port: townco/tsrs reads include reasons from outside the crate to maintain a module graph.

use std::sync::Arc;

use tsrs_core::P;
use tsrs_core::tspath::Path;
use tsrs_tsoptions::{self as tsoptions, ParseConfigHost};
use tsrs_vfs::{FS, vfstest};

use tsrs_compiler::{
    FileIncludeKind, FileIncludeReason, ProgramOptions, new_compiler_host, new_program,
};

struct ParseConfigHostImpl {
    fs: Arc<dyn FS>,
}

impl ParseConfigHost for ParseConfigHostImpl {
    fn fs(&self) -> &dyn FS {
        &*self.fs
    }
    fn get_current_directory(&self) -> &'static str {
        "/"
    }
}

fn reasons(reasons: &[P<FileIncludeReason>]) -> Vec<(FileIncludeKind, Option<&'static str>)> {
    reasons.iter().map(|reason| (reason.kind(), reason.referencing_file())).collect()
}

#[test]
fn include_reasons_expose_kind_and_referencing_file() {
    let files = [
        (
            "/src/tsconfig.json",
            r#"{"compilerOptions":{"noLib":true,"module":"commonjs"},"files":["index.ts"]}"#,
        ),
        ("/src/index.ts", "import { a } from './a'; export const b = a;"),
        ("/src/a.ts", "export const a = 1;"),
    ];
    let fs: Arc<dyn FS> = Arc::new(vfstest::from_map(files, true));
    let config_host: &'static ParseConfigHostImpl =
        Box::leak(Box::new(ParseConfigHostImpl { fs: Arc::clone(&fs) }));
    let (config, diagnostics) = tsoptions::get_parsed_command_line_of_config_file(
        "/src/tsconfig.json",
        None,
        None,
        config_host,
        None,
    );
    assert_eq!(diagnostics, [] as [P<tsrs_ast::Diagnostic>; 0]);
    let program = new_program(ProgramOptions::new(
        P::new(config.unwrap()),
        new_compiler_host("/", fs, "", None, None, None),
    ));

    let include_reasons = program.get_include_reasons();
    assert_eq!(
        reasons(&include_reasons[&Path::from("/src/index.ts")]),
        [(FileIncludeKind::RootFile, None)],
    );
    assert_eq!(
        reasons(&include_reasons[&Path::from("/src/a.ts")]),
        [(tsrs_compiler::fileIncludeKind::Import, Some("/src/index.ts"))],
    );
}
