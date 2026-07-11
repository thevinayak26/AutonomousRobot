#!/usr/bin/env python3
"""atlas_voice_bridge.py - /voice_command JSON -> Nav2 motion. Stage 3.
Pose-lookup logic is ROS-free (testable via --selftest, no robot)."""
import argparse, json, math, sys

def resolve_goal(cmd, locations):
    if not isinstance(cmd, dict):
        return ("ignore", "not a dict")
    command = cmd.get("command"); target = cmd.get("target")
    frame_id = locations.get("frame_id", "map"); targets = locations.get("targets", {})
    if command == "STOP":
        return ("cancel", None)
    if command == "RETURN":
        home = locations.get("home", "dock")
        if home not in targets: return ("ignore", f"home '{home}' not in locations")
        return ("navigate", {"frame_id": frame_id, **_pose(targets[home])})
    if command == "NAVIGATE":
        if target is None: return ("ignore", "navigate with no target")
        if target not in targets: return ("ignore", f"unknown target '{target}'")
        return ("navigate", {"frame_id": frame_id, **_pose(targets[target])})
    return ("ignore", f"unknown command '{command}'")

def _pose(p):
    return {"x": float(p["x"]), "y": float(p["y"]), "yaw": float(p.get("yaw", 0.0))}

def yaw_to_quat(yaw):
    return (0.0, 0.0, math.sin(yaw/2.0), math.cos(yaw/2.0))

def _selftest():
    locs = {"frame_id":"map","home":"dock","targets":{
        "dock":{"x":-2.6,"y":-1.8,"yaw":0.0},"desk":{"x":2.6,"y":-1.8,"yaw":1.57}}}
    cases = [
        ({"command":"NAVIGATE","target":"dock"},("navigate",{"frame_id":"map","x":-2.6,"y":-1.8,"yaw":0.0})),
        ({"command":"NAVIGATE","target":"desk"},("navigate",{"frame_id":"map","x":2.6,"y":-1.8,"yaw":1.57})),
        ({"command":"NAVIGATE","target":"mars"},("ignore","unknown target 'mars'")),
        ({"command":"NAVIGATE","target":None},("ignore","navigate with no target")),
        ({"command":"STOP","target":None},("cancel",None)),
        ({"command":"RETURN","target":None},("navigate",{"frame_id":"map","x":-2.6,"y":-1.8,"yaw":0.0})),
        ({"command":"FLY","target":"moon"},("ignore","unknown command 'FLY'")),
        ("garbage",("ignore","not a dict")),
    ]
    p=0
    for cmd,exp in cases:
        got=resolve_goal(cmd,locs); ok=got==exp; p+=ok
        print(f"[{'PASS' if ok else 'FAIL'}] {str(cmd):46} -> {got}")
    print(f"\n{p}/{len(cases)} lookup tests passed")
    return p==len(cases)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--locations", default="locations.yaml")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a=ap.parse_args()
    if a.selftest:
        sys.exit(0 if _selftest() else 1)
    import yaml, rclpy
    from rclpy.node import Node
    from rclpy.action import ActionClient
    from std_msgs.msg import String
    from geometry_msgs.msg import PoseStamped
    from nav2_msgs.action import NavigateToPose
    locations=yaml.safe_load(open(a.locations))
    class VB(Node):
        def __init__(self):
            super().__init__("atlas_voice_bridge")
            self.loc=locations; self.dry=a.dry_run
            self.nav=ActionClient(self, NavigateToPose, "navigate_to_pose")
            self.goal_handle=None
            self.create_subscription(String, "/voice_command", self.on_cmd, 10)
            self.get_logger().info(f"bridge up. targets={list(locations.get('targets',{}))} dry={self.dry}")
        def on_cmd(self,msg):
            try: cmd=json.loads(msg.data)
            except json.JSONDecodeError:
                self.get_logger().warn(f"bad JSON: {msg.data!r}"); return
            act,pl=resolve_goal(cmd,self.loc)
            if act=="ignore": self.get_logger().info(f"ignoring: {pl}"); return
            if act=="cancel":
                self.get_logger().info("STOP: cancelling goals")
                if not self.dry and self.goal_handle is not None:
                    self.goal_handle.cancel_goal_async()
                    self.get_logger().info("cancel request sent to Nav2")
                return
            if act=="navigate": self.send(pl)
        def send(self,p):
            g=NavigateToPose.Goal(); ps=PoseStamped()
            ps.header.frame_id=p["frame_id"]; ps.header.stamp=self.get_clock().now().to_msg()
            ps.pose.position.x=p["x"]; ps.pose.position.y=p["y"]
            _,_,qz,qw=yaw_to_quat(p["yaw"]); ps.pose.orientation.z=qz; ps.pose.orientation.w=qw
            g.pose=ps
            self.get_logger().info(f"NAVIGATE -> ({p['x']:.2f},{p['y']:.2f},yaw {p['yaw']:.2f})")
            if self.dry: self.get_logger().info("dry-run: not sent"); return
            if not self.nav.wait_for_server(timeout_sec=3.0):
                self.get_logger().error("Nav2 not available"); return
            fut=self.nav.send_goal_async(g)
            fut.add_done_callback(self._on_goal_response)
        def _on_goal_response(self,fut):
            gh=fut.result()
            if gh is None or not gh.accepted:
                self.get_logger().error("goal rejected by Nav2"); self.goal_handle=None; return
            self.goal_handle=gh
            self.get_logger().info("goal accepted by Nav2")
    rclpy.init(); n=VB()
    try: rclpy.spin(n)
    except KeyboardInterrupt: pass
    finally: n.destroy_node(); rclpy.shutdown()

if __name__=="__main__":
    main()
