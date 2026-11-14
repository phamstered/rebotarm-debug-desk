// Copyright 2026 Robot Console contributors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Keep ownership in the source registry until the native operation succeeds.
//! The caller runs on the GUI thread, with both windows protected from removal.
use std::collections::BTreeMap;
use std::sync::{mpsc::{channel, Sender}, Mutex};

/// GUI callbacks (including event delivery) read the parent while a worker
/// waits for relocation. Never retain its lock across dispatch or the reply.
pub(crate) fn request<K: Copy, E>(
  parent: &Mutex<K>,
  dispatch: impl FnOnce(K, Sender<Result<(), E>>) -> Result<(), E>,
  disconnected: E,
) -> Result<(), E> {
  let source = *parent.lock().unwrap();
  let (tx, rx) = channel();
  dispatch(source, tx)?;
  rx.recv().map_err(|_| disconnected)?
}

pub(crate) trait Container {
  type View;
  fn available(&self) -> bool;
  fn views(&self) -> &[Self::View];
  fn views_mut(&mut self) -> &mut Vec<Self::View>;
  fn received_child(&mut self);
}

pub(crate) fn relocate<K: Copy + Ord, C: Container, E>(
  windows: &mut BTreeMap<K, C>,
  source: K,
  target: K,
  matches: impl Fn(&C::View) -> bool,
  native_move: impl FnOnce(&C::View, &C) -> Result<(), E>,
  missing: E,
) -> Result<(), E> {
  let Some(origin) = windows.get(&source).filter(|window| window.available()) else {
    return Err(missing);
  };
  let Some(index) = origin.views().iter().position(matches) else {
    return Err(missing);
  };
  let Some(destination) = windows.get(&target).filter(|window| window.available()) else {
    return Err(missing);
  };
  if source == target {
    return Ok(());
  }
  // No remove/clone/drop before this fallible operation. A failed move leaves
  // the original JS heap, context and native WebView owned by its source.
  native_move(&origin.views()[index], destination)?;
  let view = windows.get_mut(&source).unwrap().views_mut().remove(index);
  let destination = windows.get_mut(&target).unwrap();
  destination.views_mut().push(view);
  destination.received_child();
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::{cell::Cell, rc::Rc};
  #[test]
  fn waiting_for_reparent_does_not_block_gui_events_reading_parent() {
    let parent = Mutex::new(1);
    request(&parent, |source, tx| {
      assert_eq!(source, 1);
      // The real main thread can deliver workspace_page_ready before handling
      // the queued reparent. It must acquire this same routing lock freely.
      let mut gui_parent = parent.try_lock().expect("GUI event blocked by waiting caller");
      assert_eq!(*gui_parent, 1);
      *gui_parent = 2;
      drop(gui_parent);
      tx.send(Ok(())).unwrap();
      Ok(())
    }, "disconnected").unwrap();
    assert_eq!(*parent.lock().unwrap(), 2);
    assert_eq!(request(&parent, |source, tx| {
      assert_eq!(source, 2);
      assert!(parent.try_lock().is_ok());
      tx.send(Err("native failure")).unwrap();
      Ok(())
    }, "disconnected"), Err("native failure"));
    assert_eq!(*parent.lock().unwrap(), 2);
    assert_eq!(request(&parent, |_, _tx| Ok(()), "disconnected"), Err("disconnected"));
  }
  struct View { id: u32, payload: String, drops: Rc<Cell<u32>> }
  impl Drop for View { fn drop(&mut self) { self.drops.set(self.drops.get()+1); } }
  struct Parent { available: bool, children: bool, views: Vec<View> }
  impl Container for Parent {
    type View = View;
    fn available(&self) -> bool { self.available }
    fn views(&self) -> &[View] { &self.views }
    fn views_mut(&mut self) -> &mut Vec<View> { &mut self.views }
    fn received_child(&mut self) { self.children = true; }
  }
  fn fixture() -> (BTreeMap<u32, Parent>, Rc<Cell<u32>>) {
    let drops=Rc::new(Cell::new(0));
    let mut parents=BTreeMap::new();
    parents.insert(1, Parent { available:true, children:true, views:vec![View {id:7,payload:"unsaved samples and zoom".into(),drops:drops.clone()}] });
    parents.insert(2, Parent { available:true, children:false, views:vec![] });
    (parents,drops)
  }
  #[test]
  fn native_failure_never_drops_or_moves_page_and_success_moves_exactly_once() {
    let (mut windows,drops)=fixture();
    for _ in 0..50 {
      assert_eq!(relocate(&mut windows,1,2,|v|v.id==7,|_,_|Err("native"),"missing"),Err("native"));
      assert_eq!(windows[&1].views[0].payload,"unsaved samples and zoom");
      assert!(windows[&2].views.is_empty());
      assert_eq!(drops.get(),0);
    }
    relocate(&mut windows,1,2,|v|v.id==7,|_,_|Ok(()),"missing").unwrap();
    assert!(windows[&1].views.is_empty());
    assert!(windows[&2].children);
    assert_eq!(windows[&2].views[0].payload,"unsaved samples and zoom");
    assert_eq!(drops.get(),0);
    drop(windows); assert_eq!(drops.get(),1);
  }
  #[test]
  fn missing_and_same_parent_requests_never_call_native_or_remove_source() {
    let (mut windows,drops)=fixture();
    for (from,to,id) in [(9,2,7),(1,9,7),(1,2,8)] {
      assert_eq!(relocate(&mut windows,from,to,|v|v.id==id,|_,_|panic!("must not call native"),"missing"),Err("missing"));
    }
    windows.get_mut(&2).unwrap().available=false;
    assert_eq!(relocate(&mut windows,1,2,|v|v.id==7,|_,_|panic!("closed target"),"missing"),Err("missing"));
    relocate(&mut windows,1,1,|v|v.id==7,|_,_|panic!("same parent"),"missing").unwrap();
    assert_eq!(windows[&1].views.len(),1); assert_eq!(drops.get(),0);
  }
}
