import Foundation
import UIKit.UIView

protocol Greeter {
    func greet(name: String) -> String
}

struct Person: Greeter {
    let name: String

    func greet(name: String) -> String {
        return "Hello, \(name)"
    }

    func shout() {
        print(greet(name: name).uppercased())
    }
}

class Robot {
    var serial: Int = 0

    init(serial: Int) {
        self.serial = serial
    }

    func boot() {
        Robot.staticHello()
        self.beep()
    }

    func beep() {}

    static func staticHello() {
        print("hi")
    }
}

enum Color { case red, green, blue }

extension Person {
    func wave() {
        shout()
    }
}

func freeFunc(p: Person) -> String {
    let r = Robot(serial: 1)
    r.boot()
    return p.greet(name: "world")
}
