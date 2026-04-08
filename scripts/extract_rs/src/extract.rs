use quote::ToTokens;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedSignature {
    pub file_path: String,
    pub signatures: String,
    pub types: String,
    pub imports: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedTypeDefinition {
    pub name: String,
    pub kind: String,
    pub definition: String,
    pub file_path: String,
}

#[derive(Serialize, Debug)]
pub struct ExtractionResult {
    pub signatures: Vec<ExtractedSignature>,
    pub types: Vec<ExtractedTypeDefinition>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

pub fn extract_files(paths: &[String], cwd: &Path) -> ExtractionResult {
    let cwd_abs = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let mut result = ExtractionResult {
        signatures: Vec::new(),
        types: Vec::new(),
        warnings: Vec::new(),
    };

    for path_str in paths {
        let path = Path::new(path_str);
        let abs = if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        };

        if let Ok(abs_c) = abs.canonicalize() {
            if !abs_c.starts_with(&cwd_abs) {
                eprintln!("warning: skipping path outside cwd: {}", path_str);
                continue;
            }
        }

        match extract_file(&abs) {
            Ok((sig, types)) => {
                result.signatures.push(sig);
                result.types.extend(types);
            }
            Err(e) => {
                result.warnings.push(format!("{}: {}", abs.display(), e));
                result.signatures.push(ExtractedSignature {
                    file_path: abs.display().to_string(),
                    signatures: String::new(),
                    types: String::new(),
                    imports: String::new(),
                });
            }
        }
    }

    result
}

fn extract_file(
    path: &Path,
) -> Result<(ExtractedSignature, Vec<ExtractedTypeDefinition>), String> {
    let contents = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let file = syn::parse_file(&contents).map_err(|e| e.to_string())?;

    let file_path = path.display().to_string();
    let mut sig_lines: Vec<String> = Vec::new();
    let mut type_defs: Vec<ExtractedTypeDefinition> = Vec::new();
    let mut import_lines: Vec<String> = Vec::new();

    for item in &file.items {
        match item {
            syn::Item::Use(item_use) => {
                if is_visible(&item_use.vis) {
                    sig_lines.push(item_to_string(item));
                } else {
                    import_lines.push(item_to_string(item));
                }
            }
            syn::Item::Fn(item_fn) if is_visible(&item_fn.vis) => {
                sig_lines.push(fn_signature(item_fn));
            }
            syn::Item::Struct(item_struct) if is_visible(&item_struct.vis) => {
                let header = struct_header(item_struct);
                sig_lines.push(header);
                type_defs.push(ExtractedTypeDefinition {
                    name: item_struct.ident.to_string(),
                    kind: "type".to_string(),
                    definition: item_to_string(item),
                    file_path: file_path.clone(),
                });
            }
            syn::Item::Enum(item_enum) if is_visible(&item_enum.vis) => {
                let header = enum_header(item_enum);
                sig_lines.push(header);
                type_defs.push(ExtractedTypeDefinition {
                    name: item_enum.ident.to_string(),
                    kind: "enum".to_string(),
                    definition: item_to_string(item),
                    file_path: file_path.clone(),
                });
            }
            syn::Item::Trait(item_trait) if is_visible(&item_trait.vis) => {
                let header = trait_header(item_trait);
                sig_lines.push(header);
                type_defs.push(ExtractedTypeDefinition {
                    name: item_trait.ident.to_string(),
                    kind: "interface".to_string(),
                    definition: trait_definition(item_trait),
                    file_path: file_path.clone(),
                });
            }
            syn::Item::Type(item_type) if is_visible(&item_type.vis) => {
                let def = item_to_string(item);
                sig_lines.push(def.clone());
                type_defs.push(ExtractedTypeDefinition {
                    name: item_type.ident.to_string(),
                    kind: "type".to_string(),
                    definition: def,
                    file_path: file_path.clone(),
                });
            }
            syn::Item::Const(item_const) if is_visible(&item_const.vis) => {
                let def = const_signature(item_const);
                sig_lines.push(def.clone());
                type_defs.push(ExtractedTypeDefinition {
                    name: item_const.ident.to_string(),
                    kind: "const".to_string(),
                    definition: def,
                    file_path: file_path.clone(),
                });
            }
            syn::Item::Static(item_static) if is_visible(&item_static.vis) => {
                sig_lines.push(static_signature(item_static));
            }
            _ => {}
        }
    }

    Ok((
        ExtractedSignature {
            file_path,
            signatures: sig_lines.join("\n"),
            types: String::new(),
            imports: import_lines.join("\n"),
        },
        type_defs,
    ))
}

fn is_visible(vis: &syn::Visibility) -> bool {
    !matches!(vis, syn::Visibility::Inherited)
}

fn item_to_string(item: &syn::Item) -> String {
    item.to_token_stream().to_string()
}

fn fn_signature(item: &syn::ItemFn) -> String {
    let mut parts: Vec<String> = Vec::new();
    for attr in &item.attrs {
        parts.push(attr.to_token_stream().to_string());
    }
    let vis = &item.vis;
    let sig = &item.sig;
    parts.push(quote::quote!(#vis #sig).to_string());
    parts.join("\n")
}

fn struct_header(item: &syn::ItemStruct) -> String {
    let vis = &item.vis;
    let ident = &item.ident;
    let generics = &item.generics;
    let params = &generics.params;
    let where_clause = &generics.where_clause;

    if params.is_empty() {
        if let Some(wc) = where_clause {
            quote::quote!(#vis struct #ident #wc).to_string()
        } else {
            quote::quote!(#vis struct #ident).to_string()
        }
    } else if let Some(wc) = where_clause {
        quote::quote!(#vis struct #ident < #params > #wc).to_string()
    } else {
        quote::quote!(#vis struct #ident < #params >).to_string()
    }
}

fn enum_header(item: &syn::ItemEnum) -> String {
    let vis = &item.vis;
    let ident = &item.ident;
    let generics = &item.generics;
    let params = &generics.params;
    let where_clause = &generics.where_clause;

    if params.is_empty() {
        if let Some(wc) = where_clause {
            quote::quote!(#vis enum #ident #wc).to_string()
        } else {
            quote::quote!(#vis enum #ident).to_string()
        }
    } else if let Some(wc) = where_clause {
        quote::quote!(#vis enum #ident < #params > #wc).to_string()
    } else {
        quote::quote!(#vis enum #ident < #params >).to_string()
    }
}

fn trait_header(item: &syn::ItemTrait) -> String {
    let vis = &item.vis;
    let unsafety = &item.unsafety;
    let ident = &item.ident;
    let generics = &item.generics;
    let params = &generics.params;
    let supertraits = &item.supertraits;

    let trait_kw = if unsafety.is_some() {
        quote::quote!(#vis unsafe trait)
    } else {
        quote::quote!(#vis trait)
    };

    let gen_part = if params.is_empty() {
        quote::quote!()
    } else {
        quote::quote!(< #params >)
    };

    let super_part = if supertraits.is_empty() {
        quote::quote!()
    } else {
        quote::quote!(: #supertraits)
    };

    quote::quote!(#trait_kw #ident #gen_part #super_part).to_string()
}

fn trait_definition(item: &syn::ItemTrait) -> String {
    let header = trait_header(item);
    let mut items_str: Vec<String> = Vec::new();

    for ti in &item.items {
        match ti {
            syn::TraitItem::Fn(f) => {
                let sig = &f.sig;
                let mut line = String::from("    ");
                for attr in &f.attrs {
                    line.push_str(&attr.to_token_stream().to_string());
                    line.push(' ');
                }
                line.push_str(&sig.to_token_stream().to_string());
                line.push(';');
                items_str.push(line);
            }
            syn::TraitItem::Type(t) => {
                let ident = &t.ident;
                let bounds = &t.bounds;
                if bounds.is_empty() {
                    items_str.push(format!("    type {};", ident));
                } else {
                    items_str.push(format!(
                        "    type {}: {};",
                        ident,
                        quote::quote!(#bounds)
                    ));
                }
            }
            syn::TraitItem::Const(c) => {
                let ident = &c.ident;
                let ty = &c.ty;
                items_str.push(format!("    const {}: {};", ident, quote::quote!(#ty)));
            }
            _ => {}
        }
    }

    format!("{} {{\n{}\n}}", header, items_str.join("\n"))
}

fn const_signature(item: &syn::ItemConst) -> String {
    let vis = &item.vis;
    let ident = &item.ident;
    let ty = &item.ty;
    let expr = &item.expr;
    let expr_str = expr.to_token_stream().to_string();
    // Keep literal values, replace complex expressions with ...
    let value = if expr_str.len() > 80 {
        "...".to_string()
    } else {
        expr_str
    };
    quote::quote!(#vis const #ident : #ty = ).to_string() + &value
}

fn static_signature(item: &syn::ItemStatic) -> String {
    let vis = &item.vis;
    let mutability = &item.mutability;
    let ident = &item.ident;
    let ty = &item.ty;
    let expr = &item.expr;
    let expr_str = expr.to_token_stream().to_string();
    let value = if expr_str.len() > 80 {
        "...".to_string()
    } else {
        expr_str
    };
    quote::quote!(#vis static #mutability #ident : #ty = ).to_string() + &value
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bollard-rs-test-{}", name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_extract_pub_fn_only() {
        let dir = temp_dir("pub-fn");
        let path = dir.join("sample.rs");
        fs::write(
            &path,
            r#"
pub fn exported_func(x: i32) -> String {
    x.to_string()
}

fn private_func() -> bool {
    true
}
"#,
        )
        .unwrap();

        let result = extract_files(&[path.display().to_string()], &dir);
        assert!(result.warnings.is_empty(), "unexpected warnings");
        assert_eq!(result.signatures.len(), 1);

        let sig = &result.signatures[0];
        assert!(
            sig.signatures.contains("exported_func"),
            "should contain exported_func"
        );
        assert!(
            !sig.signatures.contains("private_func"),
            "should not contain private_func"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_extract_struct_enum_trait() {
        let dir = temp_dir("types");
        let path = dir.join("sample.rs");
        fs::write(
            &path,
            r#"
pub struct MyData<T: Clone> {
    pub value: T,
    count: usize,
}

pub enum Status {
    Active,
    Inactive(String),
    Custom { code: u32, msg: String },
}

pub trait Handler {
    type Output;
    fn handle(&self, input: &str) -> Self::Output;
    fn name(&self) -> &str;
}
"#,
        )
        .unwrap();

        let result = extract_files(&[path.display().to_string()], &dir);
        assert!(result.warnings.is_empty(), "unexpected warnings");
        assert_eq!(result.types.len(), 3, "expected 3 type definitions");

        let kinds: std::collections::HashMap<&str, &str> = result
            .types
            .iter()
            .map(|t| (t.name.as_str(), t.kind.as_str()))
            .collect();

        assert_eq!(kinds.get("MyData"), Some(&"type"), "MyData should be type");
        assert_eq!(
            kinds.get("Status"),
            Some(&"enum"),
            "Status should be enum"
        );
        assert_eq!(
            kinds.get("Handler"),
            Some(&"interface"),
            "Handler should be interface"
        );

        let handler_def = result
            .types
            .iter()
            .find(|t| t.name == "Handler")
            .unwrap();
        assert!(
            handler_def.definition.contains("handle"),
            "trait def should include handle method"
        );
        assert!(
            handler_def.definition.contains("name"),
            "trait def should include name method"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parse_error_produces_warning() {
        let dir = temp_dir("parse-error");
        let path = dir.join("bad.rs");
        fs::write(&path, "this is not valid Rust at all!!!").unwrap();

        let result = extract_files(&[path.display().to_string()], &dir);
        assert!(!result.warnings.is_empty(), "expected warnings");
        assert_eq!(result.signatures.len(), 1, "expected 1 empty signature");
        assert!(
            result.signatures[0].signatures.is_empty(),
            "signatures should be empty for bad file"
        );
        assert!(result.types.is_empty(), "types should be empty for bad file");

        let _ = fs::remove_dir_all(&dir);
    }
}
