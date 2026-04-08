use std::fmt;

pub struct Registry<T: Clone> {
    pub items: Vec<T>,
    count: usize,
}

pub enum Status {
    Active,
    Inactive(String),
    Error { code: u32, message: String },
}

pub trait Processor {
    type Output;
    fn process(&self, input: &str) -> Self::Output;
    fn name(&self) -> &str;
}

pub fn create_registry<T: Clone>(capacity: usize) -> Registry<T> {
    Registry {
        items: Vec::with_capacity(capacity),
        count: 0,
    }
}

fn internal_helper() -> bool {
    true
}
