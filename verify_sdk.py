from typesafe_sdk import TypeSafeClient, Choice, Noul, Score

c = TypeSafeClient(api_key="local", base_url="http://127.0.0.1:8000")
r = c.system_one(
    state="I was charged twice for the same order and nobody answers my emails. I want my money back now.",
    questions={
        "area": Choice(instructions="Which product area is this about?",
                       criteria={"refund & dispute": "A billing dispute or refund request",
                                 "card": "Anything about a physical or virtual card",
                                 "other": None}),
        "urgency": Score(instructions="How urgent is this message?",
                         criteria=["Can wait", "Needs attention this week", "Needs attention today"]),
        "refund": Noul(instructions="The customer is asking for a refund.",
                       criteria={"true": "Asks for money back", "false": "Does not ask for money back"}),
        "no_instructions": Noul(),
    },
    model="laya",
)
print("model:", r.model, "usage:", r.usage)
print("choice:", r.choices["area"].choice, r.choices["area"].confidence)
print("score:", r.scores["urgency"].score, r.scores["urgency"].legend)
print("noul:", r.nouls["refund"].noul, "| fallback-instructions:", r.nouls["no_instructions"].noul)
print("models:", [m.name for m in c.models.list().models])
