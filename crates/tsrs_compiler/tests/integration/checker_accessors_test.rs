// Not a port: townco/tsrs groups a program's files by the checker that runs them, from outside the crate.

use std::sync::Arc;

use tsrs_core::P;
use tsrs_tsoptions::{self as tsoptions, ParseConfigHost};
use tsrs_vfs::{FS, vfstest};

use tsrs_compiler::{ProgramOptions, new_compiler_host, new_program};

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

#[test]
fn every_program_file_has_a_checker_within_the_count() {
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

    let count = program.checker_count();
    assert!(count >= 1);
    let sources = program.get_source_files();
    assert_eq!(sources.len(), 2);
    for &file in sources {
        let index = program.checker_index_of_file(file);
        assert!(
            index.is_some_and(|index| index < count),
            "{}: {index:?} of {count}",
            file.file_name()
        );
    }
}
