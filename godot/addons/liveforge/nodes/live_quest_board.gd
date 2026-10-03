class_name LiveQuestBoard
extends Node
## UI-agnostic quest / achievement state: listens for quest.offer, quest.update, achievement.unlocked and
## objective.dynamic directives, asks for offers and achievement checks, and reports quest signals.
## Draw it however you like from the signals and the offers / active / achievements fields.

signal quest_offered(quest: Dictionary, giver: String)
signal quest_accepted(quest: Dictionary)
signal quest_updated(quest_id: String, status: String, progress: float)
signal achievement_unlocked(achievement: Dictionary)
signal objective_added(objective: Dictionary)

## Offered but not accepted: quest id -> quest.
var offers := {}
## Accepted: quest id -> quest.
var active := {}
var completed: Array = []
var achievements: Array = []
var objectives: Array = []


func _ready() -> void:
	var lf := LiveforgeUtil.lf(self)
	if lf == null:
		push_warning("[liveforge] LiveQuestBoard: the Liveforge autoload is missing (enable the Liveforge plugin).")
		return
	lf.directive.connect(_on_directive)


## Asks quest.offer (null quest = nothing worth offering now).
func request_offer(giver: String = "", zone: String = "", context: Dictionary = {}) -> LiveforgeAsk:
	var lf := LiveforgeUtil.lf(self)
	if lf == null:
		return null
	var params := {}
	if not giver.is_empty():
		params["giver"] = giver
	if not zone.is_empty():
		params["zone"] = zone
	if not context.is_empty():
		params["context"] = context
	var a: LiveforgeAsk = lf.ask("quest.offer", params)
	a.done.connect(_on_offer_done.bind(giver))
	return a


## Asks achievement.check (recent = signal types / moment ids worth checking).
func check_achievements(recent: Array = []) -> LiveforgeAsk:
	var lf := LiveforgeUtil.lf(self)
	if lf == null:
		return null
	var a: LiveforgeAsk = lf.ask("achievement.check", {"recent": recent} if not recent.is_empty() else {})
	a.done.connect(_on_achievements_done)
	return a


## Accepts an offered quest (sends quest.accepted).
func accept(quest_id: String) -> void:
	var q: Dictionary = offers.get(quest_id, {})
	if q.is_empty():
		return
	offers.erase(quest_id)
	active[quest_id] = q
	var data := {"quest": quest_id}
	if q.has("giver"):
		data["giver"] = str(q.giver)
	_send("quest.accepted", data)
	quest_accepted.emit(q)


## Marks an active quest complete (sends quest.completed).
func complete(quest_id: String) -> void:
	if not active.has(quest_id):
		return
	completed.append(active[quest_id])
	active.erase(quest_id)
	_send("quest.completed", {"quest": quest_id})
	quest_updated.emit(quest_id, "completed", 1.0)


## Fails / abandons a quest (sends quest.failed).
func fail(quest_id: String, reason: String = "") -> void:
	active.erase(quest_id)
	offers.erase(quest_id)
	_send("quest.failed", {"quest": quest_id} if reason.is_empty() else {"quest": quest_id, "reason": reason})
	quest_updated.emit(quest_id, "failed", 0.0)


func _on_offer_done(r: Dictionary, giver: String) -> void:
	if typeof(r.get("quest")) == TYPE_DICTIONARY:
		_offer(r.quest, giver)


func _on_achievements_done(r: Dictionary) -> void:
	for ach in r.get("unlocked", []):
		if typeof(ach) == TYPE_DICTIONARY:
			_unlock(ach)


func _offer(q: Dictionary, giver: String) -> void:
	var id := str(q.get("id", ""))
	if id.is_empty() or active.has(id):
		return
	offers[id] = q
	quest_offered.emit(q, giver if not giver.is_empty() else str(q.get("giver", "")))


func _unlock(ach: Dictionary) -> void:
	var id := str(ach.get("id", ""))
	for a in achievements:
		if str(a.get("id", "")) == id:
			return
	achievements.append(ach)
	achievement_unlocked.emit(ach)


func _send(type: String, data: Dictionary) -> void:
	var lf := LiveforgeUtil.lf(self)
	if lf != null:
		lf.send_signal(type, data)


func _on_directive(kind: String, d: Dictionary) -> void:
	var args: Dictionary = d.get("args", {})
	match kind:
		"quest.offer":
			if typeof(args.get("quest")) == TYPE_DICTIONARY:
				_offer(args.quest, str(args.get("giver", "")))
		"quest.update":
			var qid := str(args.get("questId", ""))
			var st := str(args.get("status", "active"))
			if st == "completed" and active.has(qid):
				completed.append(active[qid])
				active.erase(qid)
			elif st in ["failed", "expired"]:
				active.erase(qid)
				offers.erase(qid)
			quest_updated.emit(qid, st, float(args.get("progress", 0.0)))
		"achievement.unlocked":
			if typeof(args.get("achievement")) == TYPE_DICTIONARY:
				_unlock(args.achievement)
		"objective.dynamic":
			objectives.append(args)
			objective_added.emit(args)
