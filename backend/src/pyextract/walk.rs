//! AST 遍历：把 Stmt / Expr 的所有子节点列出来。
//!
//! `deep` 用于收集导入这类需要进入嵌套定义的场景；`own_body` 用于函数体扫描，
//! 遇到嵌套的 def / class 就停住（它们各自是独立的符号）。

use rustpython_ast::{self as ast};

#[derive(Clone, Copy)]
pub enum Node<'a> {
    S(&'a ast::Stmt),
    E(&'a ast::Expr),
}

pub fn children<'a>(node: Node<'a>) -> Vec<Node<'a>> {
    let mut out: Vec<Node<'a>> = Vec::new();
    match node {
        Node::S(s) => match s {
            ast::Stmt::FunctionDef(f) => {
                if let Some(r) = &f.returns {
                    out.push(Node::E(r));
                }
                out.extend(f.decorator_list.iter().map(Node::E));
                out.extend(f.body.iter().map(Node::S));
            }
            ast::Stmt::AsyncFunctionDef(f) => {
                if let Some(r) = &f.returns {
                    out.push(Node::E(r));
                }
                out.extend(f.decorator_list.iter().map(Node::E));
                out.extend(f.body.iter().map(Node::S));
            }
            ast::Stmt::ClassDef(c) => {
                out.extend(c.bases.iter().map(Node::E));
                out.extend(c.keywords.iter().map(|k| Node::E(&k.value)));
                out.extend(c.decorator_list.iter().map(Node::E));
                out.extend(c.body.iter().map(Node::S));
            }
            ast::Stmt::Return(r) => {
                if let Some(v) = &r.value {
                    out.push(Node::E(v));
                }
            }
            ast::Stmt::Delete(d) => out.extend(d.targets.iter().map(Node::E)),
            ast::Stmt::Assign(a) => {
                out.extend(a.targets.iter().map(Node::E));
                out.push(Node::E(&a.value));
            }
            ast::Stmt::AugAssign(a) => {
                out.push(Node::E(&a.target));
                out.push(Node::E(&a.value));
            }
            ast::Stmt::AnnAssign(a) => {
                out.push(Node::E(&a.target));
                out.push(Node::E(&a.annotation));
                if let Some(v) = &a.value {
                    out.push(Node::E(v));
                }
            }
            ast::Stmt::For(f) => {
                out.push(Node::E(&f.target));
                out.push(Node::E(&f.iter));
                out.extend(f.body.iter().map(Node::S));
                out.extend(f.orelse.iter().map(Node::S));
            }
            ast::Stmt::AsyncFor(f) => {
                out.push(Node::E(&f.target));
                out.push(Node::E(&f.iter));
                out.extend(f.body.iter().map(Node::S));
                out.extend(f.orelse.iter().map(Node::S));
            }
            ast::Stmt::While(w) => {
                out.push(Node::E(&w.test));
                out.extend(w.body.iter().map(Node::S));
                out.extend(w.orelse.iter().map(Node::S));
            }
            ast::Stmt::If(i) => {
                out.push(Node::E(&i.test));
                out.extend(i.body.iter().map(Node::S));
                out.extend(i.orelse.iter().map(Node::S));
            }
            ast::Stmt::With(w) => {
                out.extend(w.items.iter().map(|it| Node::E(&it.context_expr)));
                out.extend(w.body.iter().map(Node::S));
            }
            ast::Stmt::AsyncWith(w) => {
                out.extend(w.items.iter().map(|it| Node::E(&it.context_expr)));
                out.extend(w.body.iter().map(Node::S));
            }
            ast::Stmt::Match(m) => {
                out.push(Node::E(&m.subject));
                for case in &m.cases {
                    if let Some(g) = &case.guard {
                        out.push(Node::E(g));
                    }
                    out.extend(case.body.iter().map(Node::S));
                }
            }
            ast::Stmt::Raise(r) => {
                if let Some(e) = &r.exc {
                    out.push(Node::E(e));
                }
                if let Some(c) = &r.cause {
                    out.push(Node::E(c));
                }
            }
            ast::Stmt::Try(t) => {
                out.extend(t.body.iter().map(Node::S));
                out.extend(t.orelse.iter().map(Node::S));
                out.extend(t.finalbody.iter().map(Node::S));
                out.extend(handlers(&t.handlers));
            }
            ast::Stmt::TryStar(t) => {
                out.extend(t.body.iter().map(Node::S));
                out.extend(t.orelse.iter().map(Node::S));
                out.extend(t.finalbody.iter().map(Node::S));
                out.extend(handlers(&t.handlers));
            }
            ast::Stmt::Assert(a) => {
                out.push(Node::E(&a.test));
                if let Some(m) = &a.msg {
                    out.push(Node::E(m));
                }
            }
            ast::Stmt::Expr(e) => out.push(Node::E(&e.value)),
            _ => {}
        },
        Node::E(e) => match e {
            ast::Expr::Call(c) => {
                out.push(Node::E(&c.func));
                out.extend(c.args.iter().map(Node::E));
                out.extend(c.keywords.iter().map(|k| Node::E(&k.value)));
            }
            ast::Expr::Attribute(a) => out.push(Node::E(&a.value)),
            ast::Expr::Subscript(s) => {
                out.push(Node::E(&s.value));
                out.push(Node::E(&s.slice));
            }
            ast::Expr::Starred(s) => out.push(Node::E(&s.value)),
            ast::Expr::Await(a) => out.push(Node::E(&a.value)),
            ast::Expr::IfExp(i) => {
                out.push(Node::E(&i.body));
                out.push(Node::E(&i.orelse));
                out.push(Node::E(&i.test));
            }
            ast::Expr::Lambda(l) => out.push(Node::E(&l.body)),
            ast::Expr::NamedExpr(n) => {
                out.push(Node::E(&n.target));
                out.push(Node::E(&n.value));
            }
            ast::Expr::BinOp(b) => {
                out.push(Node::E(&b.left));
                out.push(Node::E(&b.right));
            }
            ast::Expr::UnaryOp(u) => out.push(Node::E(&u.operand)),
            ast::Expr::BoolOp(b) => out.extend(b.values.iter().map(Node::E)),
            ast::Expr::Compare(c) => {
                out.push(Node::E(&c.left));
                out.extend(c.comparators.iter().map(Node::E));
            }
            ast::Expr::Dict(d) => {
                out.extend(d.keys.iter().flatten().map(Node::E));
                out.extend(d.values.iter().map(Node::E));
            }
            ast::Expr::Set(s) => out.extend(s.elts.iter().map(Node::E)),
            ast::Expr::List(l) => out.extend(l.elts.iter().map(Node::E)),
            ast::Expr::Tuple(t) => out.extend(t.elts.iter().map(Node::E)),
            ast::Expr::ListComp(c) => {
                out.push(Node::E(&c.elt));
                out.extend(comprehensions(&c.generators));
            }
            ast::Expr::SetComp(c) => {
                out.push(Node::E(&c.elt));
                out.extend(comprehensions(&c.generators));
            }
            ast::Expr::DictComp(c) => {
                out.push(Node::E(&c.key));
                out.push(Node::E(&c.value));
                out.extend(comprehensions(&c.generators));
            }
            ast::Expr::GeneratorExp(c) => {
                out.push(Node::E(&c.elt));
                out.extend(comprehensions(&c.generators));
            }
            ast::Expr::Yield(y) => {
                if let Some(v) = &y.value {
                    out.push(Node::E(v));
                }
            }
            ast::Expr::YieldFrom(y) => out.push(Node::E(&y.value)),
            ast::Expr::JoinedStr(j) => out.extend(j.values.iter().map(Node::E)),
            ast::Expr::FormattedValue(f) => {
                out.push(Node::E(&f.value));
                if let Some(s) = &f.format_spec {
                    out.push(Node::E(s));
                }
            }
            ast::Expr::Slice(s) => {
                if let Some(v) = &s.lower {
                    out.push(Node::E(v));
                }
                if let Some(v) = &s.upper {
                    out.push(Node::E(v));
                }
                if let Some(v) = &s.step {
                    out.push(Node::E(v));
                }
            }
            _ => {}
        },
    }
    out
}

/// 推导式的每个生成器：可迭代表达式、目标、以及全部 if 子句
fn comprehensions<'a>(gens: &'a [ast::Comprehension]) -> Vec<Node<'a>> {
    let mut out = Vec::new();
    for g in gens {
        out.push(Node::E(&g.iter));
        out.push(Node::E(&g.target));
        for cond in &g.ifs {
            out.push(Node::E(cond));
        }
    }
    out
}

fn handlers<'a>(hs: &'a [ast::ExceptHandler]) -> Vec<Node<'a>> {
    let mut out = Vec::new();
    for h in hs {
        let ast::ExceptHandler::ExceptHandler(e) = h;
        out.extend(e.body.iter().map(Node::S));
    }
    out
}

/// 全部子孙节点，进入嵌套定义。
pub fn deep<'a>(body: &'a [ast::Stmt]) -> Vec<Node<'a>> {
    let mut out = Vec::new();
    let mut stack: Vec<Node<'a>> = body.iter().map(Node::S).collect();
    while let Some(cur) = stack.pop() {
        out.push(cur);
        stack.extend(children(cur));
    }
    out
}

/// 函数体内的节点，遇到嵌套 def / class 就停住（它们各自是独立符号）。
pub fn own_body<'a>(body: &'a [ast::Stmt]) -> Vec<Node<'a>> {
    let mut out = Vec::new();
    let mut stack: Vec<Node<'a>> = body.iter().map(Node::S).collect();
    while let Some(cur) = stack.pop() {
        match cur {
            Node::S(ast::Stmt::FunctionDef(_)) | Node::S(ast::Stmt::AsyncFunctionDef(_)) => continue,
            Node::S(ast::Stmt::ClassDef(_)) => continue,
            _ => {}
        }
        out.push(cur);
        stack.extend(children(cur));
    }
    out
}
