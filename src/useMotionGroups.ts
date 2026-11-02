import { useEffect, useRef, useState } from "react";
import { type MotionGroup, validateMotionGroup } from "./motionGroupsLogic";
import {
  loadStoredMotionGroups,
  updateStoredMotionGroups,
} from "./motionGroupsStore";
export function useMotionGroups(profileKey: string) {
  const [state, setState] = useState({
    key: profileKey,
    groups: [] as MotionGroup[],
    ready: false,
    saving: false,
    error: "",
  });
  const key = useRef(profileKey);
  key.current = profileKey;
  const ready = useRef<string | null>(null),
    busy = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let obsolete = false;
    ready.current = null;
    setState({
      key: profileKey,
      groups: [],
      ready: false,
      saving: busy.current,
      error: "",
    });
    void loadStoredMotionGroups()
      .then((store) => {
        if (obsolete || key.current !== profileKey) return;
        ready.current = profileKey;
        setState({
          key: profileKey,
          groups: store.profiles[profileKey]?.groups ?? [],
          ready: true,
          saving: busy.current,
          error: "",
        });
      })
      .catch((error) => {
        if (!obsolete && key.current === profileKey)
          setState({
            key: profileKey,
            groups: [],
            ready: false,
            saving: busy.current,
            error: String(error),
          });
      });
    return () => {
      obsolete = true;
    };
  }, [profileKey]);
  async function change(update: (groups: MotionGroup[]) => MotionGroup[]) {
    const captured = profileKey;
    if (
      !captured.trim() ||
      key.current !== captured ||
      ready.current !== captured
    )
      throw new Error("动作组尚未成功读取，禁止覆盖文件");
    if (busy.current) throw new Error("动作组正在保存");
    busy.current = true;
    setState((s) => ({ ...s, saving: true, error: "" }));
    try {
      const store = await updateStoredMotionGroups((store) => ({
        ...store,
        profiles: {
          ...store.profiles,
          [captured]: {
            groups: update(store.profiles[captured]?.groups ?? []),
          },
        },
      }));
      if (mounted.current && key.current === captured)
        setState((s) => ({
          ...s,
          groups: store.profiles[captured].groups,
          error: "",
        }));
    } catch (error) {
      if (mounted.current && key.current === captured)
        setState((s) => ({ ...s, error: String(error) }));
      throw error;
    } finally {
      busy.current = false;
      if (mounted.current) setState((s) => ({ ...s, saving: false }));
    }
  }
  return {
    groups: state.key === profileKey ? state.groups : [],
    ready: state.key === profileKey && state.ready,
    saving: state.saving,
    error: state.key === profileKey ? state.error : "",
    saveGroup: async (group: MotionGroup) => {
      const error = validateMotionGroup(group);
      if (error) throw new Error(error);
      const snapshot = JSON.parse(JSON.stringify(group)) as MotionGroup;
      await change((groups) => [
        ...groups.filter((g) => g.id !== snapshot.id),
        snapshot,
      ]);
    },
    deleteGroup: async (id: string) => {
      await change((groups) => groups.filter((g) => g.id !== id));
    },
  };
}
